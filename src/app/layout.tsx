import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Nav } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kuromaku",
  description:
    "Versioned marketing memory with provenance, staleness propagation and evidence-backed drafts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-fg">
        <header className="flex items-center gap-6 border-b border-edge bg-panel px-4 h-11 shrink-0">
          <Link href="/" className="flex items-baseline gap-2 shrink-0">
            <span className="font-mono text-[13px] font-semibold tracking-tight">
              kuromaku
            </span>
            <span className="text-dim text-[11px] font-mono">v0 · phase 1</span>
          </Link>
          <Nav />
        </header>
        <main className="flex-1 min-h-0">{children}</main>
      </body>
    </html>
  );
}
