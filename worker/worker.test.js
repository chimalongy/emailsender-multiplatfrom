import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import worker from "./worker.js";

const mime="From: Reader <reader@example.org>\r\nTo: chima@example.com\r\nSubject: Hello\r\nMessage-ID: <one@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there";
function binding(){const rows=[];return {rows,prepare(sql){let vals=[];return {bind(...v){vals=v;return this},async first(){return null},async all(){return {results:[]}},async run(){if(sql.startsWith("INSERT"))rows.push({sql,values:vals});return {success:true}}}}}}
function msg(){let rejected;return {from:"reader@example.org",to:"chima@example.com",rawSize:mime.length,raw:new Response(mime).body,headers:new Headers({"in-reply-to":"<parent@example.com>"}),setReject(r){rejected=r},get rejection(){return rejected}}}
const env={ALLOWED_DOMAINS:"example.com",INBOUND_SECRET:"test-secret-".repeat(4),MESSAGES:binding()};
test("email handler parses and stores message in D1",async()=>{const m=msg();await worker.email(m,env);assert.equal(m.rejection,undefined);assert.equal(env.MESSAGES.rows.length,1);assert.match(env.MESSAGES.rows[0].sql,/INSERT OR IGNORE INTO messages/);assert.equal(env.MESSAGES.rows[0].values[4],"reader@example.org")});
test("email handler rejects unsupported domain and oversized messages",async()=>{const m=msg();m.to="x@other.com";await worker.email(m,env);assert.match(m.rejection,/domain/);const b=msg();b.rawSize=5000000;await worker.email(b,env);assert.match(b.rejection,/4 MiB/)});
test("D1 API serves direct requests without signature",async()=>{const body=JSON.stringify({action:"messages"}),req=new Request("https://worker.example/api/messages",{method:"POST",body,headers:{"content-type":"application/json"}});const res=await worker.fetch(req,env);assert.equal(res.status,200);});

test("signed D1 API serves mailbox list",async()=>{const body=JSON.stringify({action:"messages",folder:"inbox"}),timestamp=String(Date.now()),signature=createHmac("sha256",env.INBOUND_SECRET).update(timestamp+"."+body).digest("hex"),req=new Request("https://worker.example/api/messages",{method:"POST",body,headers:{"x-timestamp":timestamp,"x-signature":signature}});const res=await worker.fetch(req,env);assert.equal(res.status,200);assert.deepEqual(await res.json(),[])});

test("email handler dispatches HMAC-signed push notification request to APP_URL", async () => {
    let capturedUrl, capturedHeaders, capturedBody;
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, opts) => {
            capturedUrl = url;
            capturedHeaders = opts.headers;
            capturedBody = opts.body;
            return new Response('{"ok":true}');
        };
        const m = msg();
        const testEnv = { ...env, APP_URL: "https://my-app.example" };
        await worker.email(m, testEnv);
        assert.equal(capturedUrl, "https://my-app.example/api/inbound/notify");
        assert.ok(capturedHeaders["x-timestamp"]);
        assert.ok(capturedHeaders["x-signature"]);
        const expectedSig = createHmac("sha256", env.INBOUND_SECRET)
            .update(`${capturedHeaders["x-timestamp"]}.${capturedBody}`)
            .digest("hex");
        assert.equal(capturedHeaders["x-signature"], expectedSig);
        const parsed = JSON.parse(capturedBody);
        assert.equal(parsed.from, "reader@example.org");
        assert.equal(parsed.subject, "Hello");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
