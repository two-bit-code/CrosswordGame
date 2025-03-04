/* See README.md at the root of this distribution for copyright and
   license information */
/* eslint-env amd */

define('game/Edition', () => {
	// Static DB of loaded Editions, indexed by name
	const editions = {};

	/**
	 * A Scrabble-like crossword game edition.
	 *
	 * Editions define the board layout and letter bag for a specific
	 * Scrabble-like crossword game - Scrabble, Words With Friends, Lexulous,
	 * or a game you've made yourself.
	 *
	 * Editions are only loaded once, and are subsequently kept in memory.
	 * They are referred to by name in comms between the server and players,
	 * and are not sent to the browser.
	 */
	class Edition {

		/**
		 * @param spec the specification for the edition
		 * @param {Object[]} spec.bag the initial bag of letters at
		 * the start of a game. Note that the ordering is unimportant
		 * but if a dictionary is used, then there has to be a 1:1
		 * correspondence between the alphabet used to generate the
		 * DAWG and the letters in the bag. Each letter is described in an
		 * object thus:
		 * @param {string} spec.bag.letter - a code point (undefined for blank)
		 * @param {number} spec.bag.score - score for this letter
		 * @param {number} spec.bag.count - number of tiles for this letter
		 * @param {string[]} spec.layout each entry
		 * representing a row of the Lower-right quadrant of the
		 * board, so 0,0 is the middle. Each character in the strings
		 * represents the scoring for that square encoded as follows:
		 * d = double letter, D = double word
		 * t = triple letter, T = triple word
		 *  q = quad letter, Q = quad word
		 * _ = normal
		 * @param {number} spec.rackCount the number of tiles on a players rack
		 * @param {number} spec.swapCount number of tiles swappable in a turn
		 * @param {Object.<number, number>} spec.bonuses maps number of tiles
		 * played in a turn to a bonus
		 */
		constructor(spec) {
			Object.getOwnPropertyNames(spec).forEach(
				p => this[p] = spec[p]);
			this.bonuses = spec.bonuses;

			this.scores = { }; // map letter->score

			this.rows = 2 * this.layout.length - 1;
			this.cols = this.rows;

			this.alphabeta = [];
			for (let tile of this.bag) {
				if (tile.letter)
					this.alphabeta.push(tile.letter);
				else {
					tile.letter = ' '; // blank
					tile.isBlank = true;
				}
				this.scores[tile.letter] = tile.score || 0;
			}
			this.alphabet = this.alphabeta.sort().join('');
		}

		/**
		 * Promise to load this edition
		 * @return {Promise} resolves to the Edition
		 */
		static load(name) {
			if (editions[name])
				return Promise.resolve(editions[name]);

			// Use requirejs to support dependencies in the edition
			// files
			return new Promise(resolve => {
				requirejs([ `editions/${name}` ], data => {
					editions[name] = new Edition(data);
					editions[name].name = name;
					console.log(`Loaded edition ${name}`);
					resolve(editions[name]);
				});
			});
		}

		/**
		 * Get the 'type' of a square on the board
		 * @param {number} col - 0-based column
		 * @param {number} row - 0-based row
		 * @return one of d = double letter, D = double word
		 * t = triple letter, T = triple word
		 * q = quad letter, Q = quad word
		 * _ = normal
		 */
		squareType(col, row) {
			const coli = Math.abs(col - Math.floor(this.cols / 2));
			const rowi = Math.abs(row - Math.floor(this.rows / 2));
			return this.layout[coli].charAt(rowi);
		}

		toString() {
			return this.name;
		}

		/**
		 * Get the letter indices for the letters in the given word.
		 * @private
		 */
		getLetterIndices(word) {
			return word.split('')
			.map(l => this.alphabet.indexOf(l.toUpperCase()));
		}

		/**
		 * Get the score of a tile with the given letter
		 * @param {string} l letter to look up
		 * @return score of the letter, or 0 if not found
		 */
		letterScore(l) {
			return this.scores[l] ? this.scores[l] : 0;
		}
	}

	return Edition;
});
