import { NextResponse } from "next/server";
import { exportFilename, toMarkdown } from "@/lib/publish";
import { getArtifact } from "@/lib/review";

export const dynamic = "force-dynamic";

/** Markdown export (SPEC 7.8). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const artifact = await getArtifact(id);
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  return new NextResponse(toMarkdown(artifact), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(artifact)}"`,
    },
  });
}
