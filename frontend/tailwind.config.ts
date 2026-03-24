import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        slateNight: "#081421",
        statusGood: "#0f9d58",
        statusWarn: "#f6ad55",
        statusBad: "#e53e3e"
      },
      backgroundImage: {
        grid: "radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.18) 1px, transparent 0)"
      }
    }
  },
  plugins: []
};

export default config;
