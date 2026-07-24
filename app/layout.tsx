import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono, Martian_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Three faces, three roles — Design.md §4.
 *
 * The deliberate inversion: Martian Mono is the DISPLAY face, not the utility
 * face. The protagonist of this product is a bytes32 handle, so the headline
 * is the same species as the data.
 */
const martian = Martian_Mono({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-martian",
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Confide",
  description:
    "A Safe module that pays contributors confidential amounts. The treasury total stays publicly auditable; individual payouts do not.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${martian.variable} ${instrument.variable} ${jetbrains.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
