import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { getErrorMessage, Util } from "../core/Utils";
import { secureRandomInt } from "../security/SecureRandom";

type HttpClient =
  | Pick<typeof axios, "request">
  | { request: (config: AxiosRequestConfig) => Promise<AxiosResponse> };

export interface QueryDiversityConfig {
  sources: Array<
    "google-trends" | "reddit" | "news" | "wikipedia" | "local-fallback"
  >;
  deduplicate: boolean;
  mixStrategies: boolean;
  maxQueriesPerSource: number;
  cacheMinutes: number;
}

/**
 * QueryDiversityEngine fetches search queries from multiple sources to avoid patterns.
 * Supports Google Trends, Reddit, News APIs, Wikipedia, and local fallbacks.
 */
export class QueryDiversityEngine {
  private config: QueryDiversityConfig;
  private cache: Map<string, { queries: string[]; expires: number }> =
    new Map();
  private util: Util = new Util();
  private logger?: (
    source: string,
    message: string,
    level?: "info" | "warn" | "error",
  ) => void;
  private httpClient: HttpClient;

  constructor(
    config?: Partial<QueryDiversityConfig>,
    logger?: (
      source: string,
      message: string,
      level?: "info" | "warn" | "error",
    ) => void,
    httpClient?: HttpClient,
  ) {
    const maxQueriesPerSource = Math.max(
      1,
      Math.min(config?.maxQueriesPerSource || 10, 50),
    );
    const cacheMinutes = Math.max(
      1,
      Math.min(config?.cacheMinutes || 30, 1440),
    );

    this.config = {
      sources:
        config?.sources && config.sources.length > 0
          ? config.sources
          : ["google-trends", "reddit", "local-fallback"],
      deduplicate: config?.deduplicate !== false,
      mixStrategies: config?.mixStrategies !== false,
      maxQueriesPerSource,
      cacheMinutes,
    };
    this.logger = logger;
    this.httpClient = httpClient || axios;
  }

  private log(
    source: string,
    message: string,
    level: "info" | "warn" | "error" = "info",
  ): void {
    if (this.logger) {
      this.logger(source, message, level);
    }
  }

  /**
   * Generic HTTP fetch with error handling and timeout
   */
  private async fetchHttp(
    url: string,
    config?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      data?: string;
      timeout?: number;
    },
  ): Promise<string> {
    try {
      const response = await this.httpClient.request({
        url,
        method: config?.method || "GET",
        headers: config?.headers || {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        data: config?.data,
        timeout: config?.timeout || 10000,
      });
      return typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.log(
        "QUERY-FETCH",
        `HTTP request failed for ${url}: ${errorMsg}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Fetch diverse queries from configured sources
   */
  async fetchQueries(count: number): Promise<string[]> {
    const validCount = Math.max(1, Math.min(count, 200));
    const allQueries: string[] = [];

    for (const sourceName of this.config.sources) {
      try {
        const queries = await this.getFromSource(sourceName);
        allQueries.push(...queries.slice(0, this.config.maxQueriesPerSource));
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        this.log(
          "QUERY-DIVERSITY",
          `Failed to fetch from ${sourceName}: ${errorMsg}`,
          "warn",
        );
      }
    }

    let final = this.config.deduplicate
      ? Array.from(new Set(allQueries))
      : allQueries;

    if (this.config.mixStrategies && this.config.sources.length > 1) {
      final = this.interleaveQueries(final, validCount);
    }

    final = this.util.shuffleArray(final).slice(0, validCount);

    if (final.length === 0) {
      this.log(
        "QUERY-DIVERSITY",
        "All sources failed, using local fallback",
        "warn",
      );
      return this.getLocalFallback(validCount);
    }

    return final;
  }

  /**
   * Fetch from a specific source with caching
   */
  private async getFromSource(source: string): Promise<string[]> {
    this.cleanExpiredCache();

    const cached = this.cache.get(source);
    if (cached && Date.now() < cached.expires) {
      return cached.queries;
    }

    let queries: string[] = [];

    switch (source) {
      case "google-trends":
        queries = await this.fetchGoogleTrends();
        break;
      case "reddit":
        queries = await this.fetchReddit();
        break;
      case "news":
        queries = await this.fetchNews();
        break;
      case "wikipedia":
        queries = await this.fetchWikipedia();
        break;
      case "local-fallback":
        queries = this.getLocalFallback(20);
        break;
      default:
        this.log("QUERY-DIVERSITY", `Unknown source: ${source}`, "warn");
        break;
    }

    if (queries.length > 0) {
      this.cache.set(source, {
        queries,
        expires: Date.now() + this.config.cacheMinutes * 60000,
      });
    }

    return queries;
  }

  /**
   * Fetch from Google Trends (existing logic can be reused)
   */
  private async fetchGoogleTrends(): Promise<string[]> {
    try {
      const data = await this.fetchHttp(
        "https://trends.google.com/trends/api/dailytrends?geo=US",
      );
      const cleaned = data.toString().replace(")]}',", "");
      const parsed = JSON.parse(cleaned);

      const queries: string[] = [];
      for (const item of parsed.default.trendingSearchesDays || []) {
        for (const search of item.trendingSearches || []) {
          if (search.title?.query) {
            queries.push(search.title.query);
          }
        }
      }

      return queries.slice(0, 20);
    } catch {
      return [];
    }
  }

  /**
   * Fetch from Reddit (top posts from popular subreddits)
   */
  private async fetchReddit(): Promise<string[]> {
    try {
      const subreddits = [
        "news",
        "worldnews",
        "todayilearned",
        "askreddit",
        "technology",
      ];
      const randomSub = subreddits[secureRandomInt(0, subreddits.length - 1)];

      const data = await this.fetchHttp(
        `https://www.reddit.com/r/${randomSub}/hot.json?limit=15`,
      );
      const parsed = JSON.parse(data);
      const posts = parsed.data?.children || [];
      const queries: string[] = [];

      for (const post of posts) {
        const title = post.data?.title;
        if (title && title.length > 10 && title.length < 100) {
          queries.push(title);
        }
      }

      return queries;
    } catch {
      return [];
    }
  }

  /**
   * Fetch from News API (requires API key - fallback to headlines scraping)
   */
  private async fetchNews(): Promise<string[]> {
    try {
      const apiKey = process.env.NEWS_API_KEY;
      if (!apiKey) {
        return this.fetchNewsFallback();
      }

      const data = await this.fetchHttp(
        `https://newsapi.org/v2/top-headlines?country=us&pageSize=15&apiKey=${apiKey}`,
      );
      const parsed = JSON.parse(data);
      const articles = parsed.articles || [];
      return articles
        .map((a: { title?: string }) => a.title)
        .filter((t: string | undefined) => t && t.length > 10);
    } catch {
      return this.fetchNewsFallback();
    }
  }

  /**
   * Fallback news scraper (BBC/CNN headlines)
   */
  private async fetchNewsFallback(): Promise<string[]> {
    try {
      const html = await this.fetchHttp("https://www.bbc.com/news");
      const regex = /<h3[^>]*>(.*?)<\/h3>/gi;
      const matches: RegExpMatchArray[] = [];
      let match;
      while ((match = regex.exec(html)) !== null) {
        matches.push(match);
      }

      return matches
        .map((m) => m[1]?.replace(/<[^>]+>/g, "").trim())
        .filter((t: string | undefined) => t && t.length > 10 && t.length < 100)
        .slice(0, 10) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Fetch from Wikipedia (featured articles / trending topics)
   */
  private async fetchWikipedia(): Promise<string[]> {
    try {
      const data = await this.fetchHttp(
        "https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=15&format=json",
      );
      const parsed = JSON.parse(data);
      const pages = parsed.query?.random || [];
      return pages
        .map((p: { title?: string }) => p.title)
        .filter((t: string | undefined) => t && t.length > 3);
    } catch {
      return [];
    }
  }

  /**
   * Local fallback queries (curated list)
   */
  private getLocalFallback(count: number): string[] {
    const fallback = [
      "weather forecast",
      "news today",
      "stock market",
      "sports scores",
      "movie reviews",
      "recipes",
      "travel destinations",
      "health tips",
      "technology news",
      "best restaurants near me",
      "how to cook pasta",
      "python tutorial",
      "world events",
      "climate change",
      "electric vehicles",
      "space exploration",
      "artificial intelligence",
      "cryptocurrency",
      "gaming news",
      "fashion trends",
      "fitness workout",
      "home improvement",
      "gardening tips",
      "pet care",
      "book recommendations",
      "music charts",
      "streaming shows",
      "historical events",
      "science discoveries",
      "education resources",
    ];

    return this.util.shuffleArray(fallback).slice(0, count);
  }

  /**
   * Interleave queries from different sources for diversity
   * Uses a simple round-robin approach based on order of sources in config
   */
  private interleaveQueries(queries: string[], targetCount: number): string[] {
    const result: string[] = [];
    const queriesPerSource = Math.ceil(this.config.maxQueriesPerSource);
    const sourceCount = this.config.sources.length;

    if (sourceCount === 0 || queries.length === 0) {
      return queries.slice(0, targetCount);
    }

    const chunkSize = queriesPerSource;
    let sourceIndex = 0;

    for (let i = 0; i < queries.length && result.length < targetCount; i++) {
      const currentChunkStart = sourceIndex * chunkSize;
      const currentChunkEnd = currentChunkStart + chunkSize;
      const query = queries[i];

      if (query && i >= currentChunkStart && i < currentChunkEnd) {
        result.push(query);
      }

      if (i === currentChunkEnd - 1) {
        sourceIndex = (sourceIndex + 1) % sourceCount;
      }
    }

    return result.slice(0, targetCount);
  }

  /**
   * Clear cache (call between runs)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clean expired entries from cache automatically
   */
  private cleanExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now >= value.expires) {
        this.cache.delete(key);
      }
    }
  }
}
