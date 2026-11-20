#!/usr/bin/env node
import { createInterface } from "node:readline";

const EAGLE_API_URL = process.env.EAGLE_API_URL ?? "http://localhost:41595";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonSchema = JsonObject;

type Tool = {
  name: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  readOnly?: boolean;
};

type RpcId = string | number | null;
type RpcRequest = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: JsonObject };
type EagleResponse = { status: "success" | "error"; data?: JsonValue; message?: string };

const text = (description: string): JsonSchema => ({ type: "string", description });
const number = (description: string): JsonSchema => ({ type: "number", description });
const texts = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const star = number("Rating from 0 to 5");

const itemFields: Record<string, JsonSchema> = {
  name: text("Item name"),
  website: text("Source page URL"),
  annotation: text("Note shown on the item"),
  tags: texts("Tags to add"),
  star,
  folderId: text("Folder to put the item in"),
};

const tools: Tool[] = [
  { name: "get_application_info", description: "Show the running Eagle version, platform and preferences.", method: "GET", path: "/api/application/info", readOnly: true },
  { name: "get_library_info", description: "Show the open library: folders, smart folders, quick access and tag groups.", method: "GET", path: "/api/library/info", readOnly: true },
  { name: "list_recent_libraries", description: "List paths of recently opened libraries.", method: "GET", path: "/api/library/history", readOnly: true },
  {
    name: "switch_library", description: "Open another library.", method: "POST", path: "/api/library/switch",
    properties: { libraryPath: text("Path to a .library directory") }, required: ["libraryPath"],
  },
  { name: "list_folders", description: "List every folder in the open library as a tree.", method: "GET", path: "/api/folder/list", readOnly: true },
  { name: "list_recent_folders", description: "List recently used folders.", method: "GET", path: "/api/folder/listRecent", readOnly: true },
  {
    name: "create_folder", description: "Create a folder, optionally inside another one.", method: "POST", path: "/api/folder/create",
    properties: { folderName: text("Name of the new folder"), parent: text("ID of the parent folder") }, required: ["folderName"],
  },
  {
    name: "update_folder", description: "Rename a folder or change its description or color.", method: "POST", path: "/api/folder/update",
    properties: {
      folderId: text("Folder ID"),
      newName: text("New name"),
      newDescription: text("New description"),
      newColor: { type: "string", enum: ["red", "orange", "green", "yellow", "aqua", "blue", "purple", "pink"] },
    },
    required: ["folderId"],
  },
  { name: "list_tags", description: "List all tags with how many items use each.", method: "GET", path: "/api/tag/list", readOnly: true },
  { name: "list_recent_tags", description: "List recently used tags.", method: "GET", path: "/api/tag/listRecent", readOnly: true },
  {
    name: "search_items", description: "Find items by name, extension, tags or folders. Every filter must match.", method: "GET", path: "/api/item/list", readOnly: true,
    properties: {
      keyword: text("Text the item name contains"),
      ext: text("File extension, such as png"),
      tags: texts("Tags the item has"),
      folders: texts("IDs of folders the item is in"),
      orderBy: text("IMPORT (default), NAME, EXT, RESOLUTION, FILESIZE, RATING, DURATION, BTIME, MTIME, TAGS or RANDOM; prefix with - to reverse"),
      limit: number("Maximum number of items to return"),
      offset: number("Page number, counted in pages of limit items"),
    },
    required: ["limit"],
  },
  {
    name: "get_item", description: "Show one item's metadata.", method: "GET", path: "/api/item/info", readOnly: true,
    properties: { id: text("Item ID") }, required: ["id"],
  },
  {
    name: "get_item_thumbnail_path", description: "Get the file path of an item's thumbnail.", method: "GET", path: "/api/item/thumbnail", readOnly: true,
    properties: { id: text("Item ID") }, required: ["id"],
  },
  {
    name: "update_item", description: "Replace an item's tags, note, source URL or rating.", method: "POST", path: "/api/item/update",
    properties: { id: text("Item ID"), tags: texts("New full list of tags"), annotation: text("New note"), url: text("New source URL"), star },
    required: ["id"],
  },
  {
    name: "add_item_from_path", description: "Import a local file into the library.", method: "POST", path: "/api/item/addFromPath",
    properties: { path: text("Absolute path of the file"), ...itemFields }, required: ["path"],
  },
  {
    name: "add_item_from_url", description: "Download an image from a URL into the library.", method: "POST", path: "/api/item/addFromURL",
    properties: { url: text("Image URL"), ...itemFields }, required: ["url"],
  },
  {
    name: "add_bookmark", description: "Save a web page as a bookmark item.", method: "POST", path: "/api/item/addBookmark",
    properties: { url: text("Page URL"), name: text("Bookmark name"), tags: texts("Tags to add"), star, folderId: text("Folder to put the bookmark in") },
    required: ["url"],
  },
  {
    name: "move_items_to_trash", description: "Move items to Eagle's trash.", method: "POST", path: "/api/item/moveToTrash",
    properties: { itemIds: texts("IDs of the items") }, required: ["itemIds"],
  },
  {
    name: "refresh_item_thumbnail", description: "Regenerate an item's thumbnail and color palette.", method: "POST", path: "/api/item/refreshThumbnail",
    properties: { id: text("Item ID") }, required: ["id"],
  },
];

async function callEagle(tool: Tool, args: JsonObject): Promise<JsonValue | undefined> {
  const url = new URL(tool.path, EAGLE_API_URL);
  const init: RequestInit = { method: tool.method };
  if (tool.method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  } else {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(args);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(`Eagle is not reachable at ${EAGLE_API_URL}. Start Eagle and try again.`);
  }
  const body = (await response.json()) as EagleResponse;
  if (body.status !== "success") {
    throw new Error(typeof body.data === "string" ? body.data : body.message ?? `Eagle answered ${response.status}`);
  }
  return body.data;
}

function describe(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: "object", properties: tool.properties ?? {}, required: tool.required ?? [], additionalProperties: false },
    annotations: { readOnlyHint: tool.readOnly ?? false, destructiveHint: tool.name === "move_items_to_trash" },
  };
}

async function runTool(params: JsonObject) {
  const tool = tools.find((candidate) => candidate.name === params.name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
  try {
    const data = await callEagle(tool, (params.arguments as JsonObject | undefined) ?? {});
    return { content: [{ type: "text", text: data === undefined ? "Done." : JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error).message }], isError: true };
  }
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function handle(request: RpcRequest) {
  switch (request.method) {
    case "initialize": {
      const requested = request.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "eagle", version: "1.0.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.map(describe) };
    case "tools/call":
      return runTool(request.params ?? {});
    default:
      throw new RpcError(-32601, `Method not found: ${request.method}`);
  }
}

function send(message: JsonObject) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (request.id === undefined) return;
  try {
    send({ jsonrpc: "2.0", id: request.id, result: (await handle(request)) as JsonObject });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603;
    send({ jsonrpc: "2.0", id: request.id, error: { code, message: (error as Error).message } });
  }
});
