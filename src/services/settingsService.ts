export type HistoryRetention = "off" | "7" | "30" | "90" | "forever";

export interface Settings {
  /** null = save next to the original files. */
  defaultOutputDir: string | null;
  historyRetention: HistoryRetention;
}

export const DEFAULT_SETTINGS: Settings = { defaultOutputDir: null, historyRetention: "30" };

const KEY = "orangefile.settings.v1";

export const settingsService = {
  load(): Settings {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return DEFAULT_SETTINGS;
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  },
  save(s: Settings) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
  },
};

export const retentionDays = (r: HistoryRetention): number | null =>
  r === "forever" ? null : r === "off" ? 0 : Number(r);
