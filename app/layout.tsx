import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Shell from "./components/shell";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Ora | Your academic day",
  description:
    "One current plan for your classes, deadlines, and academic notices.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased text-ink bg-paper">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
