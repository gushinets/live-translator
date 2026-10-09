import { expect,test } from "@playwright/test";

test("Realtime AudioWorklet retains quiet PCM while held and drains only after resume",async({page})=> {
  await page.goto("/tests/audio/harness.html");
  test.skip(await page.evaluate(()=>typeof AudioContext==="undefined"),"Windows WebKit build lacks Web Audio; this is not a physical Safari check.");
  const result=await page.evaluate(async modulePath=> {
    const {default:url}=await import(/* @vite-ignore */ modulePath);
    const context=new AudioContext();await context.resume();
    try {
      await context.audioWorklet.addModule(url);
      const node=new AudioWorkletNode(context,"realtime-playback",{outputChannelCount:[1]});
      const silent=context.createGain();silent.gain.value=0;node.connect(silent).connect(context.destination);
      const source=new ConstantSourceNode(context,{offset:.00002});source.connect(node);source.start();
      let size=0,drained=false,failed=false;
      node.port.onmessage=({data})=> {if(data.type==="size")size=data.value;if(data.type==="drained")drained=true;if(data.type==="error")failed=true;};
      node.port.postMessage({type:"hold",value:true});node.port.postMessage({type:"begin",responseId:"synthetic"});
      await new Promise(resolve=>setTimeout(resolve,350));
      source.stop();source.disconnect();node.port.postMessage({type:"seal"});
      await new Promise(resolve=>setTimeout(resolve,100));
      const held={size,drained};node.port.postMessage({type:"hold",value:false});
      const deadline=performance.now()+2000;
      while(!drained && performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      node.port.postMessage({type:"dispose"});node.disconnect();node.port.close();
      return {held,drained,failed};
    } finally {await context.close();}
  },"/src/realtime/RealtimePlaybackProcessor.ts?worker&url");
  expect(result.held.size).toBeGreaterThan(0);expect(result.held.drained).toBe(false);
  expect(result.drained).toBe(true);expect(result.failed).toBe(false);
});
