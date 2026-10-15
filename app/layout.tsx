import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FosterFiscal",
  description: "Diagnóstico de conectividade com os serviços da DGII",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}

