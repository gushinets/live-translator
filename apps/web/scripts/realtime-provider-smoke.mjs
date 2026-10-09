import { chromium } from "@playwright/test";
import process from "node:process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout,clearTimeout } from "node:timers";

const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const seconds=Number(arg("--max-seconds")),audio=args.includes("--audio-wav")?resolve(arg("--audio-wav")):null;
if(!args.includes("--allow-paid") || !args.includes("--approved-budget") || !arg("--approved-budget") ||
  !Number.isInteger(seconds) || seconds<1 || seconds>90 || !audio) {
  throw new Error("Opt-in required: --allow-paid --approved-budget <owner-approved-budget> --max-seconds 1..90 --audio-wav <authorized ru/en fixture.wav>");
}
const header=readFileSync(audio).subarray(0,12);
if(header.toString("ascii",0,4)!=="RIFF" || header.toString("ascii",8,12)!=="WAVE")throw new Error("A WAV speech fixture is required");
const origin="http://localhost:5173";
let browser,page,timer,attemptId;
try {
  const deadline=Date.now()+seconds*1000;
  browser=await chromium.launch({headless:true,args:["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${audio}`]});
  const context=await browser.newContext({permissions:["microphone"],serviceWorkers:"block",viewport:{width:390,height:844}});
  page=await context.newPage();page.setDefaultTimeout(Math.min(15000,seconds*1000));
  await page.addInitScript(()=>{globalThis.localStorage.setItem("live-translator-owner-language","ru");globalThis.localStorage.setItem("live-translator-interlocutor-language","en");});
  const run=async()=> {
    await page.goto(origin);
    await page.getByRole("combobox",{name:"Режим перевода"}).selectOption("realtime");
    await page.getByRole("button",{name:"Начать перевод"}).click();
    await page.getByRole("button",{name:"Завершить",exact:true}).waitFor();
    const read=async()=>JSON.parse(await page.locator(".realtime-diagnostics pre").textContent());
    attemptId=(await read()).attemptId;
    await page.waitForFunction(()=> {
      const raw=globalThis.document.querySelector(".realtime-diagnostics pre")?.textContent;
      return raw && JSON.parse(raw).items.some(item=>item.requestState==="completed");
    },undefined,{timeout:Math.max(1,deadline-Date.now())});
    const result=await read();
    console.log(JSON.stringify({engine:result.engine,model:result.model,completedResponses:result.items.filter(i=>i.requestState==="completed").length,
      usage:result.usage,physicalPhoneTested:false,cost:"not calculated"},null,2));
  };
  await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Smoke time limit reached")),Math.max(1,deadline-Date.now()));})]);
} finally {
  if(timer)clearTimeout(timer);
  try {
  if(page && !page.isClosed()) {
    // End immediately, including startup failure. Explicit cleanup is a second ownership-safe fence.
    const end=page.getByRole("button",{name:"Завершить",exact:true});
    const cancel=page.getByRole("button",{name:"Отмена",exact:true});
    if(await end.count())await end.click({timeout:3000}).catch(()=>{});
    else if(await cancel.count())await cancel.click({timeout:3000}).catch(()=>{});
    if(!attemptId)attemptId=await page.locator(".realtime-diagnostics pre").textContent({timeout:1000}).then(raw=>JSON.parse(raw).attemptId).catch(()=>undefined);
    if(attemptId) {
      const response=await page.request.post(`${origin}/api/realtime/session/${encodeURIComponent(attemptId)}/cleanup`,{
        headers:{Origin:origin},data:{},timeout:20000});
      console.log(JSON.stringify({cleanup:response.ok()?await response.json():{state:"unknown",closeConfirmed:false}}));
    }
  }
  } catch {console.log(JSON.stringify({cleanup:{state:"unknown",closeConfirmed:false}}));}
  finally {await browser?.close();}
}
