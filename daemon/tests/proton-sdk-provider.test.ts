import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProtonSdkProvider, PROTON_APP_VERSION } from "../src/proton-sdk-provider.ts";

function mockClient() {
  const nodes: Record<string, Record<string, unknown>> = {
    root: { uid:"root", name:"Proton Drive", type:"folder", treeEventScopeId:"scope-1", modificationTime:new Date(0).toISOString() },
    file: { uid:"file", parentUid:"root", name:"hello.txt", type:"file", size:5, revisionUid:"rev-2", modificationTime:new Date(1).toISOString() }
  };
  return {
    async getMyFilesRootFolder() { return nodes.root; }, async getNode(uid:string) { return nodes[uid]; },
    async *iterateFolderChildrenNodeUids() { yield "file"; },
    async getFileDownloader() { return { downloadToStream(stream:WritableStream<Uint8Array>, progress:(n:number)=>void) {
      const completion=(async()=>{ const writer=stream.getWriter(); const bytes=new TextEncoder().encode("hello"); await writer.write(bytes); progress(bytes.byteLength); await writer.close(); return {}; })();
      return { completion:()=>completion };
    } }; },
    async *iterateEvents() { yield {type:"fast_forward", eventId:"10"}; yield {type:"node_updated", eventId:"11", nodeUid:"file", isTrashed:false}; yield {type:"node_deleted", eventId:"12", nodeUid:"file"}; },
    async getFileRevisionUploader() { throw new Error("unused"); }, async getFileUploader() { throw new Error("unused"); },
    async createFolder() { throw new Error("unused"); }, async renameNode() { throw new Error("unused"); },
    async *moveNodes() {}, async *trashNodes() {}
  };
}

test("SDK adapter streams downloads to disk and identifies the third-party app", async () => {
  assert.match(PROTON_APP_VERSION, /^external-drive-omarchy_drive@/);
  const provider=new ProtonSdkProvider(mockClient() as never); const root=await provider.getRoot(); assert.equal(root.id, "root");
  const directory=await mkdtemp(join(tmpdir(), "omarchy-sdk-adapter-")); const target=join(directory, "hello.txt");
  const result=await provider.downloadToPath("file", target); assert.equal(result.revision, "rev-2"); assert.equal(await readFile(target, "utf8"), "hello");
});

test("SDK adapter maps event cursors, updates and deletions without tree polling", async () => {
  const provider=new ProtonSdkProvider(mockClient() as never); await provider.getRoot(); const events=[];
  for await (const event of provider.getEvents()) events.push(event);
  assert.deepEqual(events.map(e=>[e.id,e.type,e.nodeId]), [["10","cursor","root"],["11","updated","file"],["12","trashed","file"]]);
});
