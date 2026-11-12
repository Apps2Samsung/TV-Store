/* The store in a phone or PC browser (#101): the page at http://<TV IP>:8077/.
 *
 * Nothing here installs anything. The page shows what the TV-Store screen last told the service
 * (POST /store/state from app.js: the apps with their Installed / Update state, why one cannot be
 * installed from here, the running install), and Install asks the TV-Store screen to do it
 * (POST /store/install). The screen then installs the way it does when OK is pressed on the TV, with
 * the same checks, signing and questions, and shows it. So TV-Store has to be open on the TV; the
 * page says so when it is not.
 *
 * Inline and offline: no external assets, so it works on a LAN without internet. ES5 in the page, for
 * old phone browsers; the service side runs on the TV's Node 4.4. */
'use strict';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

var CSS = ''
    + ':root{color-scheme:dark}*{box-sizing:border-box}'
    + 'body{margin:0;background:#0D1B2A;color:#F4F7FB;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:16px;line-height:1.45}'
    + '.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 80px}'
    + 'h1{font-size:24px;margin:0}.sub{color:#9FB0C6;font-size:14px;margin-top:4px}'
    + '.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px}'
    + '.live{font-size:14px;padding:6px 12px;border-radius:999px;background:rgba(48,196,110,.14);color:#30C46E;white-space:nowrap}.live.off{background:rgba(240,160,32,.14);color:#F0A020}'
    + '.card{background:#142638;border-radius:16px;padding:16px;margin-bottom:14px}'
    + '.notice{border-radius:12px;padding:12px 14px;margin-bottom:14px;background:rgba(240,160,32,.14);color:#F0A020}.notice.bad{background:rgba(255,107,94,.14);color:#FF6B5E}.notice.ok{background:rgba(48,196,110,.14);color:#30C46E}.notice.info{background:rgba(244,247,251,.06);color:#9FB0C6}'
    + '.bar{height:8px;border-radius:4px;background:rgba(244,247,251,.14);overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2DD4BF;transition:width .4s}.bar.bad i{background:#FF6B5E}'
    + '.tools{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}'
    + 'input[type=search]{flex:1 1 240px;min-width:0;padding:12px 14px;border-radius:12px;border:0;background:rgba(244,247,251,.08);color:#F4F7FB;font:inherit}'
    + '.btn{border:0;border-radius:12px;padding:10px 16px;font:inherit;font-weight:700;background:#2DD4BF;color:#042F2E;cursor:pointer}.btn.sec{background:rgba(244,247,251,.12);color:#F4F7FB}.btn[disabled]{background:rgba(244,247,251,.08);color:#9FB0C6;cursor:default}'
    + '.chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px}'
    + '.chip{flex:none;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;background:rgba(244,247,251,.08);color:#9FB0C6;cursor:pointer}.chip.on{background:#F4F7FB;color:#0D1B2A}'
    + '.grid{display:flex;flex-wrap:wrap;margin:0 -7px}.app{width:100%;padding:0 7px}@media(min-width:640px){.app{width:50%}}@media(min-width:960px){.app{width:33.333%}}'
    + '.app .card{display:flex;flex-direction:column;height:calc(100% - 14px)}'
    + '.hd{display:flex;align-items:center;gap:12px}.nm{font-weight:700;font-size:17px}.mt{color:#9FB0C6;font-size:13px}'
    + '.tile{position:relative;flex:none;width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;overflow:hidden}'
    + '.tile img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}'
    + '.desc{color:#9FB0C6;font-size:14px;margin:10px 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
    + '.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.b{font-size:12px;padding:3px 8px;border-radius:999px;background:rgba(244,247,251,.08);color:#9FB0C6}.b.ok{background:rgba(48,196,110,.14);color:#30C46E}.b.warn{background:rgba(240,160,32,.14);color:#F0A020}'
    + '.act{margin-top:auto;padding-top:10px}.act .why{color:#9FB0C6;font-size:13px;margin-top:6px}.act .btn{width:100%}'
    + '.empty{color:#9FB0C6;text-align:center;padding:40px 0}'
    + '.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100% - 32px);background:#F4F7FB;color:#0D1B2A;padding:12px 16px;border-radius:12px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4);display:none}.toast.on{display:block}';

// The page's own script: polls /store/state every 2 s and renders it. ES5.
var JS = '(function(){'
    + 'var S=null,cat="all",q="",busy={},sent={},seen={};'
    + 'var STEPS=["Downloading","Checking and signing","Installing on the TV","Ready to open"];'
    + 'var $=function(id){return document.getElementById(id)};'
    + 'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}'
    + 'function toast(t){var e=$("toast");e.textContent=t;e.className="toast on";clearTimeout(toast.t);toast.t=setTimeout(function(){e.className="toast"},6000)}'
    + 'function ago(ms){var s=Math.round(ms/1000);return s<90?s+" s":Math.round(s/60)+" min"}'
    + 'function gb(b){return b>=1073741824?(b/1073741824).toFixed(1)+" GB":Math.round(b/1048576)+" MB"}'
    + 'function req(m,p,body,cb){var x=new XMLHttpRequest();x.open(m,p,true);x.timeout=10000;'
    + 'x.onload=function(){var r=null;try{r=JSON.parse(x.responseText)}catch(e){}cb(x.status,r)};x.onerror=x.ontimeout=function(){cb(0,null)};'
    + 'if(body){x.setRequestHeader("Content-Type","application/json");x.send(JSON.stringify(body))}else x.send()}'
    + 'function tile(a){var c=((S.state&&S.state.categories)||[]).filter(function(k){return k.id===a.cat})[0],m=String(a.name||"").match(/[A-Za-z0-9]/);'
    + 'return \'<div class="tile" style="background:\'+esc(c?c.color:"#868E96")+\'">\'+esc(m?m[0].toUpperCase():"?")+(a.icon?\'<img alt="" src="/icon/\'+esc(a.icon)+\'" onerror="this.parentNode.removeChild(this)">\':"")+"</div>"}'
    + 'function badges(a){var b="";'
    + 'if(a.installed!==null)b+=a.update?\'<span class="b warn">Update to v\'+esc(a.latest)+"</span>":\'<span class="b ok">Installed\'+(a.installed?" · v"+esc(a.installed):"")+"</span>";'
    + 'else if(a.latest)b+=\'<span class="b">v\'+esc(a.latest)+"</span>";'
    + 'if(a.source)b+=\'<span class="b">\'+esc(a.source)+"</span>";if(a.variant)b+=\'<span class="b">\'+esc(a.variant)+"</span>";'
    + 'if(a.adult)b+=\'<span class="b warn">18+</span>\';if(a.root)b+=\'<span class="b warn">root</span>\';if(a.partner)b+=\'<span class="b">Partner certificate</span>\';return b}'
    + 'function action(a){var live=S.live&&S.enabled,j=S.state.job,mine=j&&j.running&&j.key===a.key,w=busy[a.key];'
    + 'if(mine)return \'<button class="btn" disabled>\'+(j.update?"Updating":"Installing")+" on the TV…</button>";'
    + 'if(w)return \'<button class="btn" disabled>Sent to the TV…</button>\';'
    + 'if(a.installed!==null&&!a.update)return a.why?\'<div class="why">\'+esc(a.why)+"</div>":"";'
    + 'var label=a.update?"Update":"Install";'
    + 'if(!a.can)return \'<button class="btn" disabled>\'+label+\'</button><div class="why">\'+esc(a.why)+"</div>";'
    + 'return \'<button class="btn" data-key="\'+esc(a.key)+\'"\'+(live?"":" disabled")+">"+label+"</button>"}'
    + 'function jobHtml(j){if(!j)return "";var pct=j.error?100:j.ok?100:Math.min(100,Math.round(j.step/4*100+8));'
    + 'var h=\'<div class="card"><div class="hd"><div style="flex:1"><div class="nm">\'+esc(j.name)+\'</div><div class="mt">\';'
    + 'h+=j.error?(j.update?"Update failed":"Install failed"):j.ok?(j.update?"Updated":"Installed")+" on the TV":(j.update?"Updating":"Installing")+": step "+Math.min(j.step+1,4)+" of 4, "+STEPS[Math.min(j.step,3)];'
    + 'h+=\'</div></div></div><div class="bar\'+(j.error?" bad":"")+\'"><i style="width:\'+pct+\'%"></i></div>\';'
    + 'if(j.error)h+=\'<div class="notice bad" style="margin:12px 0 0">\'+esc(j.error)+(j.onTv?" Answer it on the TV.":"")+"</div>";'
    + 'if(S.state.queue&&S.state.queue.length)h+=\'<div class="mt" style="margin-top:10px">Next: \'+esc(S.state.queue.join(", "))+"</div>";'
    + 'return h+"</div>"}'
    + 'function render(){if(!S)return;var st=S.state||{},tv=st.tv||{},apps=st.apps||[];'
    + '$("title").textContent="TV-Store"+(tv.model?" on "+tv.model:"");'
    + 'var sub=[];if(tv.tizen)sub.push("Tizen "+tv.tizen);if(tv.version)sub.push("TV-Store v"+tv.version);'
    + 'if(tv.certs&&tv.certs.length)sub.push("signs with "+tv.certs.map(function(c){return c.name+(c.level?" ("+c.level+")":"")}).join(", "));'
    + 'if(tv.free)sub.push(gb(tv.free)+" free");$("sub").textContent=sub.join(" · ");'
    + 'var l=$("live");if(!S.enabled){l.className="live off";l.textContent="Off in TV-Store\\u2019s Settings"}'
    + 'else if(S.live){l.className="live";l.textContent="TV-Store is open on the TV"}else{l.className="live off";l.textContent="TV-Store is not open on the TV"}'
    + 'var n="";if(!S.enabled)n+=\'<div class="notice">Installing from a browser is off. Turn on \\u201cInstall from a browser\\u201d in TV-Store\\u2019s Settings on the TV.</div>\';'
    + 'else if(!S.state)n+=\'<div class="notice">Open TV-Store on the TV. This page shows the store once TV-Store has loaded it there.</div>\';'
    + 'else if(!S.live)n+=\'<div class="notice">Open TV-Store on the TV to install from here. This is what it showed \'+ago(S.age)+" ago.</div>";'
    + 'else if(!tv.armed)n+=\'<div class="notice">TV-Store is not armed yet: open this TV in Apps2Samsung on a phone or PC and press Arm TV-Store once.</div>\';'
    + '$("notice").innerHTML=n;$("job").innerHTML=st.job?jobHtml(st.job):"";'
    + 'if(!S.state){$("grid").innerHTML="";$("chips").innerHTML="";$("updall").style.display="none";return}'
    + 'var ups=apps.filter(function(a){return a.update&&a.can});var u=$("updall");u.style.display=ups.length?"":"none";u.textContent="Update all ("+ups.length+")";u.disabled=!(S.live&&S.enabled)||!!busy["*all"];'
    + 'var cats=(st.categories||[]).filter(function(c){return apps.some(function(a){return a.cat===c.id})});'
    + 'if(cat!=="all"&&!cats.some(function(c){return c.id===cat}))cat="all";'
    + '$("chips").innerHTML=\'<button class="chip\'+(cat==="all"?" on":"")+\'" data-cat="all">All</button>\'+(apps.some(function(a){return a.installed!==null})?\'<button class="chip\'+(cat==="tv"?" on":"")+\'" data-cat="tv">On the TV</button>\':"")'
    + '+cats.map(function(c){return \'<button class="chip\'+(cat===c.id?" on":"")+\'" data-cat="\'+esc(c.id)+\'">\'+esc(c.name)+"</button>"}).join("");'
    + 'var ql=q.toLowerCase(),list=apps.filter(function(a){if(cat==="tv"&&a.installed===null)return false;if(cat!=="all"&&cat!=="tv"&&a.cat!==cat)return false;'
    + 'return !ql||(a.name+" "+(a.author||"")+" "+(a.desc||"")).toLowerCase().indexOf(ql)>=0});'
    + '$("grid").innerHTML=list.length?list.map(function(a){return \'<div class="app"><div class="card"><div class="hd">\'+tile(a)+\'<div style="min-width:0"><div class="nm">\'+esc(a.name)+\'</div><div class="mt">\'+esc(a.author?"by "+a.author:"")+\'</div></div></div><div class="badges">\'+badges(a)+\'</div>\'+(a.desc?\'<div class="desc">\'+esc(a.desc)+"</div>":"")+\'<div class="act">\'+action(a)+"</div></div></div>"}).join(""):\'<div class="empty">Nothing here.</div>\'}'
    + 'function poll(){req("GET","/store/state",null,function(code,r){if(code===200&&r&&r.ok){S=r;'
    + '(r.requests||[]).forEach(function(x){if(!sent[x.id])return;if(x.status==="taken"||x.status==="done"||x.status==="failed")delete busy[sent[x.id]];'
    + 'if(seen[x.id]===x.status)return;seen[x.id]=x.status;if(x.status==="taken")toast("The TV started it: "+x.name);if(x.status==="failed")toast("Not installed: "+x.name+(x.message?": "+x.message:""));if(x.status==="done")toast(x.name+" is on the TV")});'
    + 'render()}else if(!S){$("notice").innerHTML=\'<div class="notice bad">Cannot reach TV-Store on the TV.</div>\'}setTimeout(poll,2000)})}'
    + 'function ask(body,k,name){busy[k]=true;render();req("POST","/store/install",body,function(code,r){if(code===200&&r&&r.ok){sent[r.request.id]=k;toast("Sent to the TV: "+name)}else{delete busy[k];toast((r&&r.error)||"The TV did not answer")}render()})}'
    + 'document.addEventListener("click",function(e){var t=e.target;if(!t||!t.getAttribute)return;var c=t.getAttribute("data-cat");if(c){cat=c;render();return}'
    + 'var k=t.getAttribute("data-key");if(k&&!t.disabled){var a=(S.state.apps||[]).filter(function(x){return x.key===k})[0];if(a)ask({key:k},k,a.name);return}'
    + 'if(t.id==="updall"&&!t.disabled)ask({all:true},"*all","the updates")});'
    + '$("q").addEventListener("input",function(){q=this.value.trim();render()});poll()})();';

// The page; ip names the TV in the title until the state says its model.
function page(ip) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store</title><style>' + CSS + '</style></head><body><div class="wrap">'
        + '<div class="top"><div><h1 id="title">TV-Store</h1><div class="sub" id="sub">' + esc(ip || '') + '</div></div><span class="live off" id="live">Connecting…</span></div>'
        + '<div id="notice"></div><div id="job"></div>'
        + '<div class="tools"><input type="search" id="q" placeholder="Search apps" autocomplete="off"><button class="btn" id="updall" style="display:none">Update all</button><a class="btn sec" href="/upload" style="text-decoration:none">Send your own .wgt</a></div>'
        + '<div class="chips" id="chips"></div><div class="grid" id="grid"></div></div><div class="toast" id="toast"></div>'
        + '<script>' + JS + '</script></body></html>';
}

module.exports = { page: page };
