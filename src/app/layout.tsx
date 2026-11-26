import type { Metadata } from "next";
import Script from "next/script";
import ToastProvider from "@/components/ToastProvider";
import "./globals.css";





export const metadata: Metadata = {
  title: "STARS — Student Transaction and Appointment Request System",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1.0" />
        <Script
          src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"
          strategy="beforeInteractive"
        />
        <Script
          src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
          strategy="lazyOnload"
        />
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ToastProvider />
        {children}
      </body>
    </html>
  );
}
