import { describe,expect,it,vi } from "vitest";
import { RealtimePlayback } from "./RealtimePlayback";

describe("Realtime remote track ownership",()=> {
  it("stops remote tracks if disposal races output preparation",async()=> {
    const output=new RealtimePlayback(),stop=vi.fn();
    const stream={getTracks:()=>[{stop}]} as unknown as MediaStream;
    let ready!:()=>void;vi.spyOn(output,"prime").mockImplementation(()=>new Promise<void>(resolve=>{ready=resolve;}));
    const attaching=output.attach(stream);output.dispose();ready();
    await expect(attaching).rejects.toThrow("playback_retired");expect(stop).toHaveBeenCalledTimes(1);
  });
  it("stops a remote stream delivered after retirement",async()=> {
    const output=new RealtimePlayback(),stop=vi.fn();output.dispose();
    await expect(output.attach({getTracks:()=>[{stop}]} as unknown as MediaStream)).rejects.toThrow("playback_retired");
    expect(stop).toHaveBeenCalledOnce();
  });
});
