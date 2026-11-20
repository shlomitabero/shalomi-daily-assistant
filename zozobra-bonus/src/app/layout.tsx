import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Heebo } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["300", "400", "500", "700", "800"],
  variable: "--font-heebo",
  display: "swap",
});
const cormorant = Cormorant_Garamond({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-cormorant", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ZOZOBRA · בונוסים", template: "%s · ZOZOBRA" },
  description: "אפליקציית הבונוסים של צוות ZOZOBRA",
  applicationName: "ZOZOBRA בונוסים",
  appleWebApp: { capable: true, title: "ZOZOBRA", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0d0c0b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${cormorant.variable}`}>
      <body className="antialiased">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
