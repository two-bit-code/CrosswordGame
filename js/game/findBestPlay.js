/* See README.md at the root of this distribution for copyright and
   license information */
/* eslint-env amd */

/**
 * Calculate the best move in a Crossword game, given a dictionary,
 * a game edition, a current board state, and a player tile rack.
 * This should really be part of the 'Game' class, but is kept separate
 * because we want to be able to run it in a worker thread. Loading
 * it separately as a stand-alone function lets us both run it directly
 * or in the worker by simply changing a dependency.
 * The entry point to this module is the 'findBestPlay' function only.
 * @module game/findBestPlay
 * @exports game/findBestPlay
 */
define('game/findBestPlay', ['game/Edition', 'game/Tile', 'game/Move', 'dawg/Dictionary'], (Edition, Tile, Move, Dictionary) => {

	// Shortcuts to game information during move computation
	let board;       // class Board
	let edition;     // class Edition
	let dict;        // Class Dictionary

	let report;      // function to call when a new best play is found, or
	                 // print a progress message or error to the console.

    let bestScore;   // best score found so far
    let crossChecks; // checks for valid words on opposite axis

	//let noisy = false;

	/**
	 * Unlike Appel and Jacobsen, who anchor plays on empty squares,
	 * we anchor plays on a square with a tile that has an adjacent
	 * (horizontal or vertical) non-empty square. This significantly
	 * reduces the number of anchors that have to be evaluated.
	 * @param {number} col the square to inspect
	 * @param {number} row the square to inspect
	 * @return {boolean} true if this square is a valid anchor
	 * @private
	 */
	function isAnchor(col, row) {
		return !board.at(col, row).isEmpty()
		&& (col > 0 && board.at(col - 1, row).isEmpty()
			|| col < board.cols - 1 && board.at(col + 1, row).isEmpty()
			|| row > 0 && board.at(col, row - 1).isEmpty()
			|| row < board.rows - 1 && board.at(col, row + 1).isEmpty());
	}

	/**
	 * Return a list of the letters that are in both arrays. Does
	 * not handle blank!
	 * @param {string[]} a array of letters
	 * @param {string[]} b array of letters
	 * @return {string[]} intersection of a and b
	 * @private
	 */
	function intersection(a, b) {
		return a.filter(l => b.indexOf(l) >= 0);
	}

	/**
	 * Mainly for debug, return a list of tiles as a string.
	 * This lets us see how/if blanks have been used.
	 * @param {Tile[]} tiles
	 * @return {string}
	 * @private
	 */
	function pack(tiles) {
		let word = tiles.map(l => l.letter).join('');
		const blanks = tiles.map(l => l.isBlank ? ' ' : l.letter).join('');
		if (blanks != word)
			word += `/${blanks}`;
		return word;
	}

	/**
	 * Determine which letters can fit in each square and form a valid
	 * horizontal or vertical cross word. This returns a matrix where
	 * each [col][row] square has two lists, one of valid vertical
	 * chars and another of valid horizontal chars. The [0] lists give
	 * the letters that are valid for forming a vertical cross word,
	 * and the [1] lists give the letters valid for creating a
	 * horizontal cross word.  The indices are chosen such that the
	 * cells can be indexed using the dcol parameter in the other
	 * functions.
	 * @param {Board} board the Board
	 * @param {string[]} available the set of available letters
	 * @return {string[][][]} [c][r][2] the cross check letter matrix
	 * @private
	 */
	function computeCrossChecks(board, available) {
		const xChecks = [];

		for (let col = 0; col < board.cols; col++) {
			const thisCol = [];
			xChecks.push(thisCol);

			for (let row = 0; row < board.rows; row++) {
				const thisCell = [[], []];
				thisCol[row] = thisCell;

				if (board.at(col, row).tile) {
					// The cell isn't empty, only this letter is valid.
					thisCell[0].push(board.at(col, row).tile.letter);
					thisCell[1].push(board.at(col, row).tile.letter);
					continue;
				}

				// Find the words above and below
				let wordAbove = '';
				let r = row - 1;
				while (r >= 0 && board.at(col, r).tile) {
					wordAbove = board.at(col, r).tile.letter + wordAbove;
					r--;
				}

				let wordBelow = '';
				r = row + 1;
				while (r < board.rows && board.at(col, r).tile) {
					wordBelow += board.at(col, r).tile.letter;
					r++;
				}

				// Find the words left and right
				let wordLeft = '';
				let c = col - 1;
				while (c >= 0 && board.at(c, row).tile) {
					wordLeft = board.at(c, row).tile.letter + wordLeft;
					c--;
				}

				let wordRight = '';
				c = col + 1
				while (c != board.cols && board.at(c, row).tile) {
					wordRight += board.at(c, row).tile.letter;
					c++;
				}

				// Find which (if any) letters form a valid cross word
				for (let letter of available) {
					const h = wordLeft + letter + wordRight;

					// Is h a complete valid word, or just the letter
					// on its tod?
					const hIsWord = h.length === 1 || dict.hasWord(h);
					// Is h a valid complete word, or a legal sub-sequence?
					const hIsSeq = hIsWord || col > 0 && dict.hasSequence(h);

					const v = wordAbove + letter + wordBelow;
					const vIsWord = v.length === 1 || dict.hasWord(v);
					const vIsSeq = vIsWord || row > 0 && dict.hasSequence(v);

					if (hIsWord && vIsSeq)
						// A down word is playable with this letter, and
						// there's a valid down sequence involving the
						// letter
						thisCell[0].push(letter);

					if (vIsWord && hIsSeq)
						// An across word is playable with this letter, and
						// there's a valid across sequence involving the
						// letter
						thisCell[1].push(letter);
				}
			}
		}

		return xChecks;
	}

	/**
     * Given a position that can have a letter, recursively compute possible
     * word plays by extending down/across the board. For each word,
     * compute its point value, and update the best score
     * accordingly.
	 * 
     * @param {number} col index of the current position on the board. This
	 * is the posiiton of the last character of the word constructed so far.
     * @param {number} row index of the current position on the board. This
	 * is the posiiton of the last character of the word constructed so far.
     * @param {number} dcol 1 if the extension direction is across
     * @param {number} drow 1 if the extension direction is down
     * @param {Tile[]} rackTiles tiles remaining from the user's letter rack.
	 * @param {number} tilesPlayed number of tiles from the rack already played
	 * @param {LetterNode} dNode the current LetterNode
	 * @param {Tile[]} wordSoFar the known letters terminating at the dNode.
	 * @private
     */
	function forward(col, row,
					 dcol, drow,
					 rackTiles, tilesPlayed,
					 dNode,
					 wordSoFar) {

		// Square we're hopefully extending into
		const ecol = col + dcol;
		const erow = row + drow;

		//console.log(`forward '${pack(wordSoFar)}' ${col}:${dcol} ${row}:${drow} [${dNode.postLetters.join('')}]`);

		// Tail recurse; report words as soon as we find them
		// Are we sitting at the end of a scoring word?
		if (dNode.isEndOfWord
			&& wordSoFar.length >= 2
			&& tilesPlayed > 0
			&& (ecol == board.cols || erow == board.rows
				|| !board.at(ecol, erow).tile)) {
			const words = [];
			const score =
				  board.scorePlay(col, row, dcol, drow, wordSoFar, words);

            if (score > bestScore) {
				bestScore = score;
				//console.log(drow > 0 ? 'vertical' : 'horizontal')
                report(new Move({
					placements: wordSoFar.filter(t => !board.at(t.col, t.row).tile),
					words: words,
					score: score
				}));
			}
			else if (col == 5 && row == 6)
				report(`Reject '${pack(wordSoFar)}' at ${col},${row} ${score}`);
		}

		let available; // list of letters that can be extended with
		let playedTile = 0;

		if (ecol < board.cols && erow < board.rows) {
			// Do we have an empty cell we can extend into?
			if (board.at(ecol, erow).isEmpty()) {
				const haveBlank = rackTiles.find(l => l.isBlank);
				const xc = crossChecks[ecol][erow][dcol];
				
				available = intersection(
					dNode.postLetters,
					haveBlank ? xc : intersection(
						rackTiles.map(t => t.letter), xc));
				playedTile = 1;

			} else
				// Have pre-placed tile
				available = [ board.at(ecol, erow).tile.letter ];
		}
		else // off the board
			available = [];

		for (let letter of available) {
			let shrunkRack = rackTiles;
			if (playedTile > 0) {
				// Letter played from the rack
				const rackTile = shrunkRack.find(l => l.letter === letter)
					  || shrunkRack.find(l => l.isBlank);
				wordSoFar.push(
					new Tile({letter:letter, isBlank:rackTile.isBlank, score:rackTile.score,
							  col: ecol, row: erow}));
				shrunkRack = shrunkRack.filter(t => t !== rackTile);
			} else
				wordSoFar.push(board.at(ecol, erow).tile);

			for (let post of dNode.post) {
				if (post.letter === letter) {
					forward(ecol, erow,
							dcol, drow,
							shrunkRack, tilesPlayed + playedTile,
							post,
							wordSoFar);
				}
			}

			wordSoFar.pop();
		}
	}

	/**
     * Given a position that may be part of a word, and the letters of
	 * the word it may be part of, try to back up/left before extending
	 * down/right.
	 * 
     * @param {number} col index of the current position on the board. This
	 * is the posiiton of the last character of the word constructed so far.
     * @param {number} row index of the current position on the board. This
	 * is the posiiton of the last character of the word constructed so far.
     * @param {number} dcol 1 if the extension direction is across
     * @param {number} drow 1 if the extension direction is down
     * @param {Tile[]} rackTiles tiles remaining from the user's letter rack.
	 * @param {number} tilesPlayed number of tiles from the rack already played
	 * @param {LetterNode} anchorNode the DictNode where we started backing up
	 * @param {LetterNode} dNode the current LetterNode
	 * @param {Tile[]} wordSoFar the known letters terminating at the dNode.
	 * @private
     */
    function back(col, row,
				  dcol, drow,
				  rackTiles, tilesPlayed,
				  anchorNode, dNode,
				  wordSoFar) {

		// Square we're hopefully extending into
		const ecol = col - dcol;
		const erow = row - drow;

		let available; // the set of possible candidate letters
		let playedTile = 0;

		//console.log(`back '${pack(wordSoFar)}' ${col}:${dcol} ${row}:${drow} [${dNode.preLetters.join('')}]`);

		// Do we have an adjacent empty cell we can back up into?
        if (ecol >= 0 && erow >= 0) {
			if (board.at(ecol, erow).isEmpty()) {
				// Find common letters between the rack, cross checks, and
				// dNode pre.
				const haveBlank = rackTiles.find(l => l.isBlank);
				const xc = crossChecks[ecol][erow][dcol];

				available =
				intersection(
					dNode.preLetters,
					haveBlank ? xc : intersection(
						rackTiles.map(l => l.letter),	xc));
				playedTile = 1;
			} else
				// Non-empty square, might be able to walk back through it
				available = [ board.at(ecol, erow).tile.letter ];
		}
		else
			// Off the board, nothing available for backing up
			available = [];

		// Head recurse; longer words are more likely to
		// be high scoring, so want to find them first
		for (let letter of available) {
			let shrunkRack = rackTiles;
			if (playedTile > 0) {
				// Letter came from the rack
				const tile = shrunkRack.find(l => l.letter === letter)
					  || shrunkRack.find(l => l.isBlank);
				wordSoFar.unshift(
					new Tile({
						letter: letter,
						isBlank: tile.isBlank,
						score: tile.score,
						col: ecol,
						row: erow
					}));
				shrunkRack = shrunkRack.filter(t => t !== tile);
			} else
				// Letter already on the board
				wordSoFar.unshift(board.at(ecol, erow).tile);

			for (let pre of dNode.pre) {
				if (pre.letter === letter) {
					back(ecol, erow,
						 dcol, drow,
						 shrunkRack, tilesPlayed + playedTile,
						 anchorNode, pre,
						 wordSoFar);
				}
			}

			wordSoFar.shift();
		}

		// If this is the start of a word in the dictionary, and
		// we're at the edge of the board or the prior cell is
		// empty, then we have a valid word start.
		if (dNode.pre.length == 0
			&& (erow < 0 || ecol < 0 || board.at(ecol, erow).isEmpty())) {
			//console.log(`back word start ${ecol}:${dcol},${erow}:${drow}`);
			// try extending down beyond the anchor, with the letters
			// that we have determined comprise a valid rooted sequence.
			forward(col + dcol * (wordSoFar.length - 1),
					row + drow * (wordSoFar.length - 1),
					dcol, drow,
					rackTiles, tilesPlayed,
					anchorNode,
					wordSoFar);
		}
	}

	/**
	 * Special case of the opening move. Find anagrams of the player's
	 * rack, and find the highest scoring position for each possible word.
	 * @param {Tile[]} rackTiles tiles on the rack
	 * @private
	 */
	function bestOpeningPlay(rackTiles) {
		const ruck = rackTiles.map(l => l.letter).join('');
		const choices = dict.findAnagrams(ruck);
		// Random whether it is played across or down
		const drow = Math.round(Math.random());
		const dcol = (drow + 1) % 2;
		let bestScore = 0;

		for (let choice of Object.keys(choices)) {
			// Keep track of the rack and played letters
			const placements = [];
			let shrunkRack = rackTiles;
			for (let c of choice.split('')) {
				const rackTile = shrunkRack.find(t => t.letter == c)
					  || shrunkRack.find(t => t.isBlank);
				if (!rackTile) {
					// Can't do this with the available tiles
					choice = '';
					break;
				}
				placements.push(new Tile({
					letter: c,
					isBlank: rackTile.isBlank,
					score:rackTile.score
				}));
				shrunkRack = shrunkRack.filter(t => t !== rackTile);
			}

			// Slide the word over the middle to find the optimum
			// position
			const mid = dcol == 0 ? board.midcol : board.midrow;
			for (let end = mid;
				 end < mid + choice.length;
				 end++) {

				for (let i = 0; i < placements.length; i++) {
					const pos = end - placements.length + i + 1;
					placements[i].col = dcol == 0 ? board.midcol : pos * dcol;
					placements[i].row = drow == 0 ? board.midrow : pos * drow;
				}

				const score = board.scorePlay(
					end, mid, dcol, drow, placements);

				if (score > bestScore) {
					bestScore = score;
					//console.log(drow > 0 ? 'vertical' : 'horizontal')
					report(new Move({
						placements: placements,
						words: [{ word: choice, score: score }],
						score: score
					}));
				}
			}
		}
	}

	/*
	 * Given a user's letter rack, compute the best possible move.
	 * @function game/findBestPlay
	 * @param {Game} game the Game
	 * @param {Tile[]} rack rack in the form of a simple list of Tile
	 * @param {function} listener Function that is called with a Move each time
	 * a new best play is found, or a string containing a progress or error
	 * message.
	 * @return {Promise} Promise that resolves when all best moves have been
	 * identified
     * @alias module:game/findBestPlay
	 */
    function findBestPlay(game, rack, listener) {
		report = listener;

		if (!game.edition) {
			report('Error: Game has no edition', game);
			// Terminal, no point in translating
			return Promise.reject('Game has no edition');
		}

		if (!game.dictionary) {
			report('Error: Cannot find moves with no dictionary');
			// Terminal, no point in translating
			return Promise.reject('Game has no dictionary');
		}

		// sort and reverse to make sure high value letters come
		// first and blanks come last. It's not going to make it
		// any faster, but it will abort with a better result if
		// it's going to time out.
		const rackTiles = rack.sort((a, b) => {
			return a.letter < b.letter ? -1	: a.score > b.score ? 1 : 0;
		}).reverse();

		report('Finding best play for rack ' + rackTiles);

		board = game.board;
		report(`on ${board}`);

		const preamble = [
			Dictionary.load(game.dictionary),
			Edition.load(game.edition)
		];

		return Promise.all(preamble)
		.then(de => {
			dict = de[0];
			edition = de[1];

			report('Starting computation');
			bestScore = 0;

			// Has at least one anchor been explored? If there are
			// no anchors, we need to compute an opening play
			let anchored = false;
			for (let col = 0; col < board.cols; col++) {
				for (let row = 0; row < board.rows; row++) {
					// An anchor is any square that has a tile and has an
					// adjacent blank that can be extended into to form a word
					if (isAnchor(col, row)) {
						if (!anchored) {
							// What letters can be used to form a valid cross
							// word? The whole alphabet if the rack contains a
							// blank, the rack otherwise.
							const available = rackTiles.find(l => l.isBlank)
								  ? edition.alphabeta
								  : (rackTiles.filter(t => !t.isBlank)
									 .map(t => t.letter));
							crossChecks = computeCrossChecks(board, available);
							anchored = true;
						}
						const anchorTile = board.at(col, row).tile;
						const roots = dict.getSequenceRoots(anchorTile.letter);
						for (let anchorNode of roots) {
							// Try and back up then forward through
							// the dictionary to find longer sequences

							// across
							back(
								col, row,
								1, 0,
								rackTiles, 0,
								anchorNode, anchorNode,
								[ anchorTile ]);

							// down
							back(
								col, row,
								0, 1,
								rackTiles, 0,
								anchorNode, anchorNode,
								[ anchorTile ]);
						}
					}
				}
			}

			if (!anchored)
				// No anchors, so this is an opening play.
				bestOpeningPlay(rackTiles);

		});
	}

	return findBestPlay;
});
