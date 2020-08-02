const djs = require("discord.js");
const fse = require("fs-extra");

const { main: log } = require("./utils/debug.js");

class Counterspot {
	constructor(config) {
		if (typeof config !== "object" || config == null) {
			throw new TypeError("A config must be supplied");
		}
		this.config = config;

		/**
		 * The Discord client.
		 * @type {djs.Client}
		 */
		this.client = new djs.Client(config.token);

		this.cache = {
			/**
			 * The value of the last count.
			 * @type {number}
			 */
			lastCount: 0,
			/**
			 * The ID of the last counter.
			 * @type {string}
			 */
			lastCounter: null,
		};

		/**
		 * The channel to log to.
		 * @type {djs.TextBasedChannel?}
		 */
		this.logChannel = null;
	}

	/**
	 * Loads the cache.
	 * @returns {Object} The cache.
	 */
	async loadCache() {
		log("loading cache from %s", this.config.cachePath);
		try {
			this.cache = await fse.readJSON(this.config.cachePath);
		} catch (error) {
			log("could not load cache: %o", error);
		}
		return this.cache;
	}

	/**
	 * Saves the cache.
	 */
	async saveCache() {
		await fse.writeJSON(this.config.cachePath, this.cache);
		log("saved the cache to %s", this.config.cachePath);
	}

	/**
	 * Parses a count from a message's count.
	 * @param {string} content The message content.
	 * @returns {number} The parsed count, or NaN.
	 */
	parseCount(content) {
		const numberString = content.split(" ")[0];
		return parseFloat(numberString.replace(/[^0-9.]/g, ""));
	}

	/**
	 * Determines whether the count is correct in relation to the last count.
	 * @param {number} count The count.
	 * @returns {boolean} Whether the count is correct.
	 */
	isCorrectCount(count) {
		if (this.config.count.direction === -1) {
			return count === this.cache.lastCount - this.config.count.amount;
		} else if (this.config.count.direction === 1) {
			return count === this.cache.lastCount + this.config.count.amount;
		}

		return Math.abs(this.cache.lastCount - count) === this.config.count.amount;
	}

	/**
	 * Gets the locale string for a count;
	 * @param {number} count The count to get the locale string for.
	 * @returns {string} The locale string of the count.
	 */
	getLocaleCount(count) {
		return count.toLocaleString("en-US");
	}

	/**
	 * Gets the expected count(s) as a messag.
	 * @returns {string} The expected count(s).
	 */
	getExpectedCount() {
		switch (this.config.count.direction) {
			case -1: {
				return this.getLocaleCount(this.cache.lastCount - this.config.count.amount);
			}
			case 1: {
				return this.getLocaleCount(this.cache.lastCount + this.config.count.amount);
			}
			default: {
				return this.getLocaleCount(this.cache.lastCount - this.config.count.amount) + " or " + this.getLocaleCount(this.cache.lastCount + this.config.count.amount);
			}
		}
	}

	/**
	 * Reports a count issue for a message.
	 * @param {djs.Message} message The message to report the issue on.
	 * @param {String} issue The issue text.
	 * @param {djs.EmojiResolvable} reactionEmoji The reaction emoji to add to the reported message.
	 * @param {djs.EmbedFieldData[]} additionalLogFields Additional fields to add to the log embed.
	 */
	async reportCountIssue(message, issue, reactionEmoji, additionalLogFields = []) {
		if (this.config.report.addReaction) {
			message.react(reactionEmoji);
		}

		const embed = new djs.MessageEmbed({
			author: this.config.report.showAuthor && {
				iconURL: message.author.avatarURL(),
				name: message.author.username,
			},
			color: 0xFF0000,
			description: issue + " " + reactionEmoji,
			timestamp: this.config.report.showTimestamp && Date.now(),
			title: "Count Issue",
		});
		const issueMessage = await message.channel.send(embed);

		// Send to log channel
		if (this.logChannel) {
			const logEmbed = new djs.MessageEmbed(embed).addFields([
				{
					inline: true,
					name: "Author",
					value: `<@${message.author.id}> (\`${message.author.tag}\`)`,
				},
				{
					name: "Message",
					value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
				},
				...(this.config.report.log.showAdditionalFields ? additionalLogFields : []),
			]);
			this.logChannel.send(logEmbed);
		}

		if (typeof this.config.report.deletionTimeout === "number") {
			setTimeout(() => {
				issueMessage.delete();
			}, this.config.report.deletionTimeout);
		}
	}

	/**
	 * Determines whether a user is blacklisted from counting.
	 * @param {djs.User} user The user.
	 * @returns {boolean} Whether the user is blacklisted.
	 */
	isBlacklisted(user) {
		if (!Array.isArray(this.config.blacklist)) return false;
		return this.config.blacklist.includes(user.id);
	}

	/**
	 * Fetches the log channel.
	 */
	async fetchLogChannel() {
		const logChannelID = this.config.report.log.channel.trim();
		if (logChannelID === "") return;

		try {
			const logChannel = await this.client.channels.fetch(logChannelID);
			if (logChannel && typeof logChannel.send === "function") {
				this.logChannel = logChannel;
			} else {
				log("log channel (id: %s) must be text-based", logChannelID);
			}
		} catch (error) {
			if (error.httpStatus === 404) {
				log("could not find log channel (id: %s)", logChannelID);
			} else if (error.code === 50001) {
				log("missing access to log channel (id: %s)", logChannelID);
			} else {
				log("could not fetch log channel (id: %s): %o", logChannelID, error);
			}
		}
	}

	/**
	 * Launches the bot client and starts validating counting messages.
	 */
	async launch() {
		await this.loadCache();

		await this.client.login(this.config.token);

		if (this.config.report && this.config.report.log && typeof this.config.report.log.channel === "string") {
			await this.fetchLogChannel();
		}

		this.client.on("message", message => {
			if (message.author.bot) return;
			if (message.channel.id !== this.config.channel) return;

			if (this.isBlacklisted(message.author)) {
				return this.reportCountIssue(message, "User is blacklisted from counting", "🚫");
			}

			log("handling count by %s (id: %s)", message.author.tag, message.id);
			const count = this.parseCount(message.content);
			if (Number.isNaN(count)) {
				return this.reportCountIssue(message, "Count was not found at the beginning of the message", "❔");
			}

			if (!this.isCorrectCount(count)) {
				const expectedCount = this.getExpectedCount();
				return this.reportCountIssue(message, `Count is incorrect (expected count: ${expectedCount})`, "⚠️", [{
					inline: true,
					name: "Found Count",
					value: count,
				}, {
					inline: true,
					name: "Expected Count",
					value: expectedCount,
				}]);
			} else if (this.cache.lastCounter === message.author.id) {
				return this.reportCountIssue(message, "Cannot count multiple times in a row", "👥");
			}

			// Update cache
			this.cache.lastCounter = message.author.id;
			this.cache.lastCount = count;
			this.saveCache();
		});
	}
}
module.exports = Counterspot;