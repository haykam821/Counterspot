const djs = require("discord.js");
const fse = require("fs-extra");

const { main: log } = require("./utils/debug.js");

/**
 * A counter's statistics for a certain period.
 * @typedef {Object} CounterStatistics
 * @property {number} counts The number of counts the counter has made.
 */

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
			 * @type {Object<string, CounterStatistics>}
			 */
			countStats: {},
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
		return parseFloat(numberString.replace(/[^\d.]/g, ""));
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
	 * Gets the log version of an embed.
	 * @param {djs.Message} message The message context.
	 * @param {djs.MessageEmbed} embed The original embed.
	 * @param {djs.EmbedFieldData[]} additionalFields Additional fields to add to the log embed.
	 * @returns {djs.MessageEmbed} The log version of the embed.
	 */
	getLogEmbed(message, embed, additionalFields = []) {
		return new djs.MessageEmbed(embed).addFields([{
			inline: true,
			name: "Author",
			value: `<@${message.author.id}> (\`${message.author.tag}\`)`,
		},
		{
			name: "Message",
			value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
		},
		...(this.config.report.log.showAdditionalFields ? additionalFields : [])]);
	}

	/**
	 * Reports a count issue for a message.
	 * @param {djs.Message} message The message to report the issue on.
	 * @param {String} issue The issue text.
	 * @param {djs.EmojiResolvable} reactionEmoji The reaction emoji to add to the reported message.
	 * @param {djs.EmbedFieldData[]} additionalFields Additional fields to add to the log embed.
	 */
	async reportCountIssue(message, issue, reactionEmoji, additionalFields = []) {
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
			const logEmbed = this.getLogEmbed(message, embed, additionalFields);
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
	 * Gets a report of counter statistics.
	 * @returns {string} The counter statistics.
	 */
	getStatisticsReport() {
		/* eslint-disable-next-line no-unused-vars */
		return Object.entries(this.cache.countStats).sort(([ firstCounterID, firstStats ], [ secondCounterID, secondStats ]) => {
			return secondStats.counts - firstStats.counts;
		}).map(([ counterID, stats ]) => {
			return `• <@${counterID}> - ${stats.counts} count${stats.counts === 1 ? "" : "s"}`;
		}).join("\n");
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

		this.client.on("message", async message => {
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
			} else if (this.cache.lastCounter === message.author.id && !this.config.count.multipleBySameUser) {
				return this.reportCountIssue(message, "Cannot count multiple times in a row", "👥");
			}

			if (this.config.goal.trackStatistics) {
				if (typeof this.cache.countStats[message.author.id] !== "object") {
					// Initialize statistics for the counter
					this.cache.countStats[message.author.id] = {
						counts: 0,
					};
				}
				this.cache.countStats[message.author.id].counts += 1;
			}

			const reachedGoal = typeof this.config.goal === "object" && count % this.config.goal.multiple === 0;
			if (reachedGoal) {
				if (this.config.goal.pin) {
					message.pin().catch(error => {
						if (error.code === 50013) {
							log("could not pin goal count (id: %s) due to missing permissions", message.id);
						} else {
							log("could not pin goal count (id: %s): %o", message.id, error);
						}
					});
				}

				const announcementParts = [];

				if (this.cache.lastCounter && message.author.id !== this.cache.lastCounter) {
					announcementParts.push(`Congratulations on reaching the goal at ${count}, <@${message.author.id}>, with assistance from <@${this.cache.lastCounter}>.`);
				} else {
					announcementParts.push(`Congratulations on reaching the goal at ${count}, <@${message.author.id}>!`);
				}

				if (this.config.goal.reset) {
					announcementParts.push(`Counting can now restart at ${this.getLocaleCount(this.config.goal.resetValue)}.`);
				}

				const embed = new djs.MessageEmbed({
					author: this.config.report.showAuthor && {
						iconURL: message.author.avatarURL(),
						name: message.author.username,
					},
					color: 0x72C42B,
					description: announcementParts.join(" "),
					fields: this.config.goal.trackStatistics ? [] : [{
						name: "Statistics",
						value: this.getStatisticsReport(),
					}],
					timestamp: this.config.report.showTimestamp && Date.now(),
					title: "Counting Goal Reached",
				});

				// Reset counting statistics
				this.cache.countStats = {};

				if (this.config.goal.announce) {
					message.channel.send(embed);
				}

				const lastCounter = await message.guild.members.fetch(this.cache.lastCounter);

				if (typeof this.config.goal.roles === "object") {
					const roleReason = "Reward for reaching counting goal: " + count;

					if (this.config.goal.roles.achiever) {
						message.member.roles.add(this.config.goal.roles.achiever, roleReason).then(() => {
							log("added achiever role to %s (id: %s)", message.author.tag, message.id);
						}).catch(error => {
							log("could not add achiever role to %s (id: %s): %o", message.author.tag, message.id, error);
						});
					}
					if (this.config.goal.roles.assistant) {
						lastCounter.roles.add(this.config.goal.roles.assistant, roleReason).then(() => {
							log("added assistant role to %s (id: %s)", lastCounter.user.tag, lastCounter.id);
						}).catch(error => {
							log("could not add assistant role to %s (id: %s): %o", lastCounter.user.tag, lastCounter.id, error);
						});
					}
				}

				// Send to log channel
				if (this.logChannel) {
					const logEmbed = this.getLogEmbed(message, embed, [{
						inline: true,
						name: "Goal Count",
						value: count,
					}, {
						inline: true,
						name: "Assistant",
						value: `<@${lastCounter.id}> (\`${lastCounter.user.tag}\`)`,
					}]);
					this.logChannel.send(logEmbed);
				}
			}

			// Update cache
			this.cache.lastCounter = message.author.id;
			this.cache.lastCount = reachedGoal && this.config.goal.reset ? this.config.goal.resetValue : count;
			this.saveCache();
		});
	}
}
module.exports = Counterspot;
