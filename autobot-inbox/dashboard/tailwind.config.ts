import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0a0a0f",
          raised: "#12121a",
          overlay: "#1a1a25",
          selected: "#1a1a2e",
        },
        accent: {
          DEFAULT: "#6366f1",
          dim: "#4f46e5",
          bright: "#818cf8",
        },
        status: {
          action: "#ef4444",
          response: "#f59e0b",
          fyi: "#3b82f6",
          noise: "#6b7280",
          approved: "#22c55e",
        },
      },
      animation: {
        "fade-in": "fadeIn 150ms cubic-bezier(0.4, 0, 0.2, 1)",
        "bulk-bar": "bulkBar 250ms cubic-bezier(0, 0, 0.2, 1)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        bulkBar: {
          "0%": { opacity: "0", transform: "translateX(-50%) translateY(100%)" },
          "100%": { opacity: "1", transform: "translateX(-50%) translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
