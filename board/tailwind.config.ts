import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

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
        "status-approved": "#10b981",
      },
      borderRadius: {
        card: "12px",
        bubble: "16px",
      },
      animation: {
        "fade-in": "fadeIn 150ms cubic-bezier(0.4, 0, 0.2, 1)",
        "slide-in": "slideIn 200ms cubic-bezier(0.4, 0, 0.2, 1)",
        "slide-up": "slideUp 200ms cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideIn: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(0)" },
        },
        slideUp: {
          "0%": { transform: "translateY(100%)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "50%": { transform: "translateX(200%)" },
          "100%": { transform: "translateX(-100%)" },
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
