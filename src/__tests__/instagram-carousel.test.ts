import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../services/api.js";
import { registerInstagramTools } from "../tools/instagram.js";

describe("meta_publish_instagram_carousel", () => {
  const tools = new Map<string, any>();
  const order: string[] = [];
  const post = vi.fn();
  const pollContainerStatus = vi.fn();

  beforeEach(() => {
    tools.clear();
    order.length = 0;
    let n = 0;
    post.mockReset().mockImplementation(async (path: string, fields: Record<string, unknown>) => {
      if (path.endsWith("/media_publish")) {
        order.push("publish");
        return { id: "published" };
      }
      if (fields.media_type === "CAROUSEL") {
        order.push("carousel");
        return { id: "carousel1" };
      }
      return { id: `item${++n}` };
    });
    pollContainerStatus.mockReset().mockImplementation(async (id: string) => {
      order.push(`poll:${id}`);
      return "FINISHED";
    });
    const server = { registerTool(name: string, config: any, run: any) { tools.set(name, { config, run }); } } as unknown as McpServer;
    registerInstagramTools(server, { post, pollContainerStatus } as unknown as MetaApiClient);
  });

  const call = (args: any) => { const t = tools.get("meta_publish_instagram_carousel"); return t.run(t.config.inputSchema.parse(args)); };
  const images = [
    { url: "https://example.com/a.jpg", type: "IMAGE" },
    { url: "https://example.com/b.jpg", type: "IMAGE" },
  ];

  it("polls every IMAGE container before creating the parent carousel", async () => {
    const result = await call({ ig_account_id: "ig", items: images });
    expect(order).toEqual(["poll:item1", "poll:item2", "carousel", "publish"]);
    expect(pollContainerStatus).toHaveBeenCalledWith("item1", "instagram");
    expect(post.mock.calls.find(([, f]) => f.media_type === "CAROUSEL")![1].children).toBe("item1,item2");
    expect(result.content[0].text).toContain("published successfully");
  });

  it("polls video and image containers alike", async () => {
    await call({ ig_account_id: "ig", items: [images[0], { url: "https://example.com/v.mp4", type: "VIDEO" }] });
    expect(pollContainerStatus).toHaveBeenCalledTimes(2);
    expect(order.indexOf("carousel")).toBeGreaterThan(order.indexOf("poll:item2"));
  });

  it("does not assemble the carousel when an image container fails to finish", async () => {
    pollContainerStatus.mockImplementation(async (id: string) => (id === "item2" ? "ERROR" : "FINISHED"));
    const result = await call({ ig_account_id: "ig", items: images });
    expect(result.content[0].text).toContain("`item2` (ERROR)");
    expect(post.mock.calls.some(([, f]) => f.media_type === "CAROUSEL")).toBe(false);
    expect(post.mock.calls.some(([p]) => p.endsWith("/media_publish"))).toBe(false);
  });
});
