import { Client, Intents, Snowflake } from "discord.js";
import { CountDirection, CounterspotConfig } from "./utils/get-config";
import { EmbedFieldData, EmojiResolvable, Message, MessageEmbed, TextChannel, User } from "discord.js";

import fse from "fs-extra";
import { log } from "./utils/debug";

/**
 * A counter's statistics for a certain period.
 */
interface CounterStatistics {
	/**
	 * The number of counts the counter has made.
	 */
	counts: number;
}

interface CountingCache {
	countStats: Record<Snowflake, CounterStatistics>;
	/**
	 * The value of the last count.
	 */
	lastCount: number;
	/**
	 * The ID of the last counter.
	 */
	lastCounter: Snowflake;
}

export default class Counterspot {
	private readonly config: CounterspotConfig;
	/**
	 * The Discord client.
	 */
	private readonly client: Client;
	/**
	 * The channel to log to.
	 */
	private logChannel: TextChannel = null;
	private cache: CountingCache = {
		countStats: {},
		lastCount: 0,
		lastCounter: null,
	};

	constructor(config: CounterspotConfig) {
		if (typeof config !== "object" || config == null) {
			throw new TypeError("A config must be supplied");
		}
		this.config = config;

		this.client = new Client({
			intents: [
				Intents.FLAGS.GUILDS,
				Intents.FLAGS.GUILD_MESSAGES,
				Intents.FLAGS.DIRECT_MESSAGES,
			],
		});

		this.handleMessage = this.handleMessage.bind(this);
	}

	/**
	 * Loads the cache.
	 * @returns The cache.
	 */
	async loadCache(): Promise<CountingCache> {
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
	async saveCache(): Promise<void> {
		await fse.writeJSON(this.config.cachePath, this.cache);
		log("saved the cache to %s", this.config.cachePath);
	}

	/**
	 * Parses a count from a message's count.
	 * @param content The message content.
	 * @returns The parsed count, or NaN.
	 */
	parseCount(content: string): number {
		const numberString = content.split(" ")[0];
		return parseFloat(numberString.replace(/[^\d.]/g, ""));
	}

	/**
	 * Determines whether the count is correct in relation to the last count.
	 * @param count The count.
	 * @returns Whether the count is correct.
	 */
	isCorrectCount(count: number): boolean {
		if (this.config.count.direction === CountDirection.NEGATIVE) {
			return count === this.cache.lastCount - this.config.count.amount;
		} else if (this.config.count.direction === CountDirection.POSITIVE) {
			return count === this.cache.lastCount + this.config.count.amount;
		}

		return Math.abs(this.cache.lastCount - count) === this.config.count.amount;
	}

	/**
	 * Gets the locale string for a count;
	 * @param count The count to get the locale string for.
	 * @returns The locale string of the count.
	 */
	getLocaleCount(count: number): string {
		return count.toLocaleString("en-US");
	}

	/**
	 * Gets the expected count(s) as a messag.
	 * @returns The expected count(s).
	 */
	getExpectedCount(): string {
		switch (this.config.count.direction) {
			case CountDirection.NEGATIVE: {
				return this.getLocaleCount(this.cache.lastCount - this.config.count.amount);
			}
			case CountDirection.POSITIVE: {
				return this.getLocaleCount(this.cache.lastCount + this.config.count.amount);
			}
			default: {
				return this.getLocaleCount(this.cache.lastCount - this.config.count.amount) + " or " + this.getLocaleCount(this.cache.lastCount + this.config.count.amount);
			}
		}
	}

	/**
	 * Gets the log version of an embed.
	 * @param message The message context.
	 * @param embed The original embed.
	 * @param additionalFields Additional fields to add to the log embed.
	 * @returns The log version of the embed.
	 */
	getLogEmbed(message: Message, embed: MessageEmbed, additionalFields: EmbedFieldData[] = []): MessageEmbed {
		return new MessageEmbed(embed).addFields([{
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
	 * @param message The message to report the issue on.
	 * @param issue The issue text.
	 * @param reactionEmoji The reaction emoji to add to the reported message.
	 * @param additionalFields Additional fields to add to the log embed.
	 */
	async reportCountIssue(message: Message, issue: string, reactionEmoji: EmojiResolvable, additionalFields: EmbedFieldData[] = []): Promise<void> {
		if (this.config.report.addReaction) {
			message.react(reactionEmoji);
		}

		const embed = new MessageEmbed({
			author: this.config.report.showAuthor && {
				iconURL: message.author.avatarURL(),
				name: message.author.username,
			},
			color: 0xFF0000,
			description: issue + " " + reactionEmoji,
			timestamp: this.config.report.showTimestamp && Date.now(),
			title: "Count Issue",
		});
		const issueMessage = await message.channel.send({
			embeds: [
				embed,
			],
		});

		// Send to log channel
		if (this.logChannel) {
			const logEmbed = this.getLogEmbed(message, embed, additionalFields);
			this.logChannel.send({
				embeds: [
					logEmbed,
				],
			});
		}

		if (typeof this.config.report.deletionTimeout === "number") {
			setTimeout(() => {
				issueMessage.delete();
			}, this.config.report.deletionTimeout);
		}
	}

	/**
	 * Determines whether a user is blacklisted from counting.
	 * @param user The user.
	 * @returns Whether the user is blacklisted.
	 */
	isBlacklisted(user: User): boolean {
		if (!Array.isArray(this.config.blacklist)) return false;
		return this.config.blacklist.includes(user.id);
	}

	/**
	 * Fetches the log channel.
	 */
	async fetchLogChannel(): Promise<void> {
		const logChannelID = this.config.report.log.channel.trim();
		if (logChannelID === "") return;

		try {
			const logChannel = await this.client.channels.fetch(logChannelID);
			if (logChannel && logChannel instanceof TextChannel) {
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
	 * @returns The counter statistics.
	 */
	getStatisticsReport(): string {
		/* eslint-disable-next-line no-unused-vars */
		return Object.entries(this.cache.countStats)
			.sort((firstEntry, secondEntry) => {
				return firstEntry[1].counts - secondEntry[1].counts;
			})
			.map(([ counterID, stats ]) => {
				return `• <@${counterID}> - ${stats.counts} count${stats.counts === 1 ? "" : "s"}`;
			})
			.join("\n");
	}

	/**
	 * Launches the bot client and starts validating counting messages.
	 */
	async launch(): Promise<void> {
		await this.loadCache();

		await this.client.login(this.config.token);

		if (this.config.report && this.config.report.log && typeof this.config.report.log.channel === "string") {
			await this.fetchLogChannel();
		}

		this.client.on("messageCreate", this.handleMessage);
	}

	private async handleMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (message.channel.id !== this.config.channel) return;

		if (this.isBlacklisted(message.author)) {
			return this.reportCountIssue(message, "User is blacklisted from counting", "🚫");
		}

		log("handling count by %s (id: %s)", message.author.tag, message.id);
		const count = this.parseCount(message.content);
		await this.handleCount(message, count);
	}

	private async handleCount(message: Message, count: number): Promise<void> {
		if (Number.isNaN(count)) {
			return this.reportCountIssue(message, "Count was not found at the beginning of the message", "❔");
		}

		if (!this.isCorrectCount(count)) {
			const expectedCount = this.getExpectedCount();
			return this.reportCountIssue(message, `Count is incorrect (expected count: ${expectedCount})`, "⚠️", [{
				inline: true,
				name: "Found Count",
				value: count.toString(),
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
			await this.handleGoalReached(message, count);
		}

		// Update cache
		this.cache.lastCounter = message.author.id;
		this.cache.lastCount = reachedGoal && this.config.goal.reset ? this.config.goal.resetValue : count;
		this.saveCache();
	}

	private async handleGoalReached(message: Message, count: number): Promise<void> {
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

		const embed = new MessageEmbed({
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
			message.channel.send({
				embeds: [
					embed,
				],
			});
		}

		const lastCounter = await message.guild.members.fetch(this.cache.lastCounter);

		if (typeof this.config.goal.roles === "object") {
			const roleReason = "Reward for reaching counting goal: " + count;

			if (this.config.goal.roles.achiever) {
				try {
					await message.member.roles.add(this.config.goal.roles.achiever, roleReason);
					log("added achiever role to %s (id: %s)", message.author.tag, message.id);
				} catch (error) {
					log("could not add achiever role to %s (id: %s): %o", message.author.tag, message.id, error);
				}
			}
			if (this.config.goal.roles.assistant) {
				try {
					await lastCounter.roles.add(this.config.goal.roles.assistant, roleReason);
					log("added assistant role to %s (id: %s)", lastCounter.user.tag, lastCounter.id);
				} catch (error) {
					log("could not add assistant role to %s (id: %s): %o", lastCounter.user.tag, lastCounter.id, error);
				}
			}
		}

		// Send to log channel
		if (this.logChannel) {
			const logEmbed = this.getLogEmbed(message, embed, [{
				inline: true,
				name: "Goal Count",
				value: count.toString(),
			}, {
				inline: true,
				name: "Assistant",
				value: `<@${lastCounter.id}> (\`${lastCounter.user.tag}\`)`,
			}]);
			this.logChannel.send({
				embeds: [
					logEmbed,
				],
			});
		}
	}
}
