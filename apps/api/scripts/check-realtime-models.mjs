import OpenAI from "openai";
import process from "node:process";
import console from "node:console";
// Read-only access check in the API's Node/.env/SDK/proxy environment. No calls are created.
try {
  const client=new OpenAI({maxRetries:0,timeout:20000});
  const {data,response}=await client.models.list().withResponse();
  const ids=new Set(data.data.map(model=>model.id));
  console.log(JSON.stringify({status:response.status,liveVisible:ids.has("gpt-live-1"),
    realtimeVisible:ids.has(process.env.REALTIME_MODEL??"gpt-realtime-2.1"),
    transcriptionVisible:ids.has(process.env.REALTIME_TRANSCRIPTION_MODEL??"gpt-4o-transcribe")},null,2));
} catch(error) {
  console.error(JSON.stringify({status:error.status??null,category:error.name??"unknown",providerChecked:false}));
  process.exitCode=1;
}
