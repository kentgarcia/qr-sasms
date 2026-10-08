import fs from "fs";
import path from "path";
import Script from "next/script";

export const dynamic = "force-dynamic";
export const revalidate = 0;






export default function Home() {
  const bodyHtml = fs.readFileSync(path.join(process.cwd(), "src", "content", "body.html"), "utf8");

  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      
      <Script src="/app.js?v=20260930settings" strategy="afterInteractive" />
    </>
  );
}
