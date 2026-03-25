import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        creamBg: "#fbf6ee",
        creamCard: "#f5ead8",
        creamCard2: "#efe0c9",
        brownInk: "#2b1d12",
        brownMuted: "#6b4f3a",
        brownBorder: "#cbb89e",
        statusGood: "#0f9d58",
        statusWarn: "#f6ad55",
        statusBad: "#e53e3e"
      },
      backgroundImage: {
        grid: "radial-gradient(circle at 1px 1px, rgba(107, 79, 58, 0.15) 1px, transparent 0)"
      }
    }
  },
  plugins: []
};

export default config;
