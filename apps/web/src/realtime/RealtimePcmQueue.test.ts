import { describe,expect,it } from "vitest";
import { RealtimePcmQueue } from "./RealtimePcmQueue";
describe("Realtime PCM preservation",()=> {
  it("outputs the exact unfiltered sequence once across hold, receive, seal and resume",()=> {
    const queue=new RealtimePcmQueue(100),samples=Float32Array.from([.00001,-.000001,0,.5,-.25,0,.000003,1,-1,0]);
    const played:number[]=[];queue.begin();
    const first=new Float32Array(2);queue.process(samples.slice(0,2),first);played.push(...first);
    queue.held=true;const silence=new Float32Array(3);queue.process(samples.slice(2,5),silence);expect([...silence]).toEqual([0,0,0]);
    queue.process(samples.slice(5),new Float32Array(5));queue.seal();expect(queue.pendingSamples).toBe(8);
    queue.process(undefined,new Float32Array(4));expect(queue.pendingSamples).toBe(8);
    queue.held=false;const tail=new Float32Array(8);queue.process(undefined,tail);played.push(...tail);
    expect(played).toEqual([...samples]);expect(queue.pendingSamples).toBe(0);
  });
  it("fails overflow explicitly and distinguishes discard from hold",()=> {
    const q=new RealtimePcmQueue(2);q.begin();q.held=true;
    expect(()=>q.process(new Float32Array([1,2,3]),new Float32Array(3))).toThrow("pcm_limit");
    expect(q.pendingSamples).toBe(2);q.discard();expect(q.pendingSamples).toBe(0);
  });
});
