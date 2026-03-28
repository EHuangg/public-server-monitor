import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Evan's Server",
  description: "monitor my PC for me pls :)",
  icons: {
    icon: "/images/favico.ico",
    shortcut: "/images/favico.ico",
    apple: "/images/favico.ico",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
