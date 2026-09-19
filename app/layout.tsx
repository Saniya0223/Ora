import type { Metadata } from "next";
import "./globals.css";
import Shell from "./components/shell";

export const metadata: Metadata = {
  title: "CampusFlow | Your academic day",
  description:
    "One current plan for your classes, deadlines, and academic notices.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
