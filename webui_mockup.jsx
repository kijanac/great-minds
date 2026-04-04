import { useState, useRef, useCallback, useEffect } from "react";

const ARTICLES_1 = ["imperialism","finance-capital","kautsky-ultra-imperialism","vladimir-lenin","hilferding-finance-capital","national-question","war-and-capitalism","second-international"];
const ARTICLES_2 = ["luxemburg","national-question","spontaneism","mass-strike"];

const ANSWER_1 = `## The Debate on Imperialism and Finance Capital

Lenin's theory of imperialism emerged from a specific conjuncture: the outbreak of World War I and the collapse of the Second International. His central argument in *Imperialism, the Highest Stage of Capitalism* (1916) was that capitalism had entered a new phase defined by the dominance of finance capital — the fusion of bank and industrial capital described by Hilferding — which drove the territorial division of the world among the great powers.

### Against Kautsky

The sharpest polemical edge of Lenin's theory was directed at Kautsky's concept of *ultra-imperialism*: the thesis that the major powers might transcend inter-imperialist rivalry through a cooperative cartel of capital at the world scale. For Lenin this was not merely empirically wrong but ideologically dangerous — it provided a theoretical justification for supporting one's own imperialist power in wartime by suggesting the system was moving toward peaceful integration rather than intensifying contradiction.

Lenin's counter-argument was that uneven development made ultra-imperialism structurally impossible. Because capitalism develops different sectors and regions at different rates, the relative strength of national capitals is constantly shifting, making stable inter-imperialist cooperation inherently unstable.

### The National Question

The theory of imperialism connected directly to Lenin's position on the national question. If imperialism meant the forcible subordination of colonial and semi-colonial peoples to finance capital, then national liberation movements represented an objective force against imperialism — regardless of their class character — and socialist movements in the imperial centers had an obligation to support them unconditionally.

This position brought Lenin into tension with both the left (Luxemburg's skepticism about national self-determination) and the right (those who subordinated colonial questions to metropolitan class struggle).

### Legacy and Revision

Post-war debates substantially revised the theory. Dependency theorists extended it to explain the structural underdevelopment of the periphery. World-systems theory (Wallerstein) recast it in terms of core-periphery relations across the longue durée. More recent Marxist work (Harvey's *accumulation by dispossession*) has updated the mechanism while retaining the basic insight that capitalism requires continuous expansion into new territories and spheres.`;

const ANSWER_2 = `## Uneven Development and the Ultra-Imperialism Thesis

The structural argument against Kautsky hinges on uneven and combined development — most fully elaborated by Trotsky but implicit throughout Lenin's imperialism writings. The core claim is that capitalism does not develop all regions, sectors, and national capitals at the same pace or in the same direction.

This unevenness means that any cooperative arrangement among imperial powers is inherently temporary. A cartel stable today becomes unstable tomorrow as the relative strength of its members shifts. Britain's hegemonic position in the late 19th century gave way to German and American challenges precisely because uneven development continuously redistributed economic and military weight.

Kautsky's ultra-imperialism thesis implicitly assumed that the major powers could lock in their relative positions through cooperation. Lenin's reply was that this assumption was structurally impossible — not merely empirically unlikely — because the forces producing unevenness are internal to capitalism itself and cannot be suspended by political agreement.`;

const BTW_ANSWER = `Luxemburg's critique was embedded in her broader disagreement about spontaneity versus organization. She argued that abstract support for national liberation movements risked subordinating proletarian internationalism to bourgeois nationalist politics — a concern that proved prescient in several post-colonial contexts where communist parties found themselves backing national bourgeoisies against their own working classes.`;

const BTW_REPLY = `That's a significant tension in the theory. Lenin's resolution was to insist on the distinction between the right to self-determination — which socialists must support in principle — and the exercise of that right, which must be evaluated politically in each concrete conjuncture. A right can be acknowledged without being endorsed as the correct political choice in every instance.`;

const ARTICLE_DETAIL = {
  imperialism: { title:"Imperialism", tags:["economics","political-theory","leninism","finance-capital"], tradition:"marxist-leninist", date:1916, body:`Lenin's theory identifies five defining features of the imperialist stage: the concentration of production into monopolies; the merging of bank and industrial capital into finance capital; the export of capital as the dominant economic relation; the formation of international capitalist associations; and the territorial division of the world among the great powers.\n\nThe theory emerged from systematic engagement with Hobson, Hilferding, Bukharin, and — polemically — Kautsky. It was written under conditions of wartime censorship and carries the marks of its conjuncture throughout.` },
  "finance-capital": { title:"Finance Capital", tags:["economics","hilferding","banking","monopoly"], tradition:"austro-marxism", date:1910, body:`Hilferding's Finance Capital (1910) provided the theoretical foundation for subsequent Marxist theories of imperialism. His central argument was that capitalism produces a progressive fusion of bank and industrial capital into a new form — finance capital — which exercises dominance over the entire economy.\n\nLenin drew heavily on this analysis while departing from Hilferding's political conclusions. Where Hilferding saw the possibility of democratic control over finance capital within capitalism, Lenin argued that finance capital was inseparable from imperialism and militarism.` },
};

let _id = 0;
const uid = () => `x${++_id}`;

function parseMarkdown(text) {
  const segs = []; let pi = 0;
  text.split("\n").forEach((line, i) => {
    if (line.startsWith("## "))       segs.push({ type:"h2", text:line.slice(3), key:`${i}` });
    else if (line.startsWith("### ")) segs.push({ type:"h3", text:line.slice(4), key:`${i}` });
    else if (!line.trim())            segs.push({ type:"gap", key:`${i}` });
    else                              segs.push({ type:"p", text:line, key:`${i}`, pi:pi++ });
  });
  return segs;
}

function Inline({ text }) {
  return text.split(/(\*[^*]+\*)/g).map((p,i) =>
    p.startsWith("*") && p.endsWith("*") ? <em key={i}>{p.slice(1,-1)}</em> : p
  );
}

function streamInterval(text, onChunk, onDone, speed=5) {
  let i = 0;
  const iv = setInterval(() => {
    i += speed; onChunk(text.slice(0, i));
    if (i >= text.length) { clearInterval(iv); onChunk(text); onDone(); }
  }, 14);
  return iv;
}

// ── BTW Thread ────────────────────────────────────────────────────────────────
function BtwThread({ btw, onReply }) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(true);
  const shortAnchor = btw.anchor.length > 58 ? btw.anchor.slice(0,58)+"…" : btw.anchor;

  return (
    <div className="btw">
      <button className="btw-hd" onClick={() => setOpen(o=>!o)}>
        <span className="btw-lbl">BTW</span>
        <span className="btw-anc">"{shortAnchor}"</span>
        <span className="btw-chv">{open?"▾":"▸"}</span>
      </button>
      {open && (
        <div className="btw-bd">
          {btw.messages.map((m,i) => (
            <div key={i} className={`bm bm-${m.role}`}>
              {m.role==="user" && <span className="bm-you">you · </span>}
              {m.text}
            </div>
          ))}
          {btw.streaming && (
            <div className="bm bm-assistant">{btw.streamText}<span className="cur-s"/></div>
          )}
          {!btw.streaming && (
            <div className="btw-inp-row">
              <input className="btw-inp" placeholder="continue…"
                value={input} onChange={e=>setInput(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter"&&input.trim()){ onReply(btw.id,input.trim()); setInput(""); } }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Answer block ──────────────────────────────────────────────────────────────
function AnswerBlock({ text, exId, btws=[], onBtwReply, streaming, onSel }) {
  const segs = parseMarkdown(text);
  const byPara = {};
  btws.forEach(b => { (byPara[b.pi]=byPara[b.pi]||[]).push(b); });
  const lastP = [...segs].filter(s=>s.type==="p").at(-1);

  return (
    <div className="md" onMouseUp={e=>{ if(!streaming) onSel(e,exId); }}>
      {segs.map(s => {
        if (s.type==="h2") return <h2 key={s.key} className="md-h2">{s.text}</h2>;
        if (s.type==="h3") return <h3 key={s.key} className="md-h3">{s.text}</h3>;
        if (s.type==="gap") return <div key={s.key} className="md-gap"/>;
        return (
          <div key={s.key}>
            <p className="md-p" data-pi={s.pi} data-exid={exId}>
              <Inline text={s.text}/>
              {streaming && s===lastP && <span className="cur"/>}
            </p>
            {(byPara[s.pi]||[]).map(b=>(
              <BtwThread key={b.id} btw={b} onReply={onBtwReply}/>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Source cards ──────────────────────────────────────────────────────────────
function SourceCards({ cards, active, onPick }) {
  const [col, setCol] = useState(false);
  if (!cards.length) return null;
  return (
    <div className={`cards ${col?"cards-col":"cards-exp"}`}>
      {col ? (
        <button className="tog" onClick={()=>setCol(false)}>
          <span className="tog-dots">{[0,1,2,3].map(i=><span key={i} className="tog-dot"/>)}</span>
          {cards.length} sources
        </button>
      ) : (
        <>
          <div className="cards-row">
            {cards.map((a,i)=>(
              <div key={a} className={`card ${active===a?"card-on":""}`}
                style={{animationDelay:`${i*40}ms`}} onClick={()=>onPick(a)}>
                {a}
              </div>
            ))}
          </div>
          <button className="tog" style={{marginTop:7}} onClick={()=>setCol(true)}>collapse sources</button>
        </>
      )}
    </div>
  );
}

// ── Article panel ─────────────────────────────────────────────────────────────
function ArticlePanel({ article, onClose }) {
  const d = ARTICLE_DETAIL[article] || {
    title: article.split("-").map(w=>w[0].toUpperCase()+w.slice(1)).join(" "),
    tags:["political-theory"], tradition:"marxist", date:1917,
    body:"Article content rendered from the wiki markdown file.",
  };
  return (
    <div className="panel">
      <div className="panel-hd">
        <div className="ptitle-row">
          <span className="ptitle">{d.title}</span>
          <button className="xbtn" onClick={onClose}>×</button>
        </div>
        <div className="pmeta">
          {d.tradition&&<span className="pill pill-t">{d.tradition}</span>}
          {d.date&&<span className="pill pill-d">{d.date}</span>}
        </div>
        <div className="ptags">{d.tags.map(t=><span key={t} className="ptag">#{t}</span>)}</div>
      </div>
      <div className="panel-bd">
        {d.body.split("\n\n").map((p,i)=><p key={i}>{p}</p>)}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [query, setQuery]       = useState("");
  const [phase, setPhase]       = useState("idle");
  const [thread, setThread]     = useState([]);
  const [liveCards, setLC]      = useState([]);
  const [liveText, setLT]       = useState("");
  const [panelArt, setPanelArt] = useState(null);
  const [chips, setChips]       = useState([]);
  const [fuInput, setFuInput]   = useState("");
  const [popover, setPop]       = useState(null);
  const [saved, setSaved]       = useState(false);

  const barRef    = useRef(null);
  const threadRef = useRef(null);
  const ivRef     = useRef(null);

  const isActive = phase !== "idle";
  const canFu    = phase === "done";

  useEffect(() => {
    if (threadRef.current)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [liveText, thread.length]);

  useEffect(() => {
    const h = e => { if (!e.target.closest(".pop")) setPop(null); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const runExchange = useCallback((q, articles, answerText) => {
    const exId = uid();
    setPhase("searching"); setLC([]); setLT(""); setSaved(false);
    articles.forEach((a,i) => {
      setTimeout(() => {
        setLC(p=>[...p,a]);
        if (i===articles.length-1) {
          setTimeout(() => {
            setPhase("streaming");
            ivRef.current = streamInterval(answerText, t=>setLT(t), ()=>{
              setThread(p=>[...p,{id:exId,query:q,cards:articles,answer:answerText,btws:[]}]);
              setLC([]); setLT(""); setPhase("done");
            });
          }, 350);
        }
      }, i*200);
    });
  }, []);

  const handleSubmit = () => {
    if (!query.trim() || phase!=="idle") return;
    runExchange(query, ARTICLES_1, ANSWER_1);
  };

  const handleFU = () => {
    const q = [...chips.map(c=>`re: "${c}"`), fuInput].filter(Boolean).join(" · ");
    if (!q.trim()) return;
    setChips([]); setFuInput("");
    runExchange(q, ARTICLES_2, ANSWER_2);
  };

  const handleReset = () => {
    if (ivRef.current) clearInterval(ivRef.current);
    setPhase("idle"); setQuery(""); setThread([]);
    setLC([]); setLT(""); setPanelArt(null);
    setChips([]); setFuInput(""); setPop(null); setSaved(false);
    setTimeout(()=>barRef.current?.focus(), 80);
  };

  const handleSel = useCallback((e, exId) => {
    const sel = window.getSelection();
    if (!sel||sel.isCollapsed||sel.toString().trim().length<5) { setPop(null); return; }
    const text = sel.toString().trim();
    let pi = -1, node = sel.anchorNode;
    while (node&&node!==document.body) {
      if (node.dataset?.pi!==undefined) { pi=parseInt(node.dataset.pi); break; }
      node = node.parentElement;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPop({ text, x: rect.left+rect.width/2, y: rect.top-6, pi, exId });
  }, []);

  const handleAddChip = () => {
    if (!popover) return;
    setChips(p=>[...p, popover.text]);
    setPop(null); window.getSelection()?.removeAllRanges();
  };

  const handleBtw = useCallback(() => {
    if (!popover) return;
    const btwId = uid();
    const { text:anchor, pi, exId } = popover;
    const init = { id:btwId, anchor, pi, exId, messages:[], streaming:true, streamText:"" };

    setThread(p=>p.map(ex=>ex.id===exId?{...ex,btws:[...ex.btws,init]}:ex));
    setPop(null); window.getSelection()?.removeAllRanges();

    const iv = streamInterval(BTW_ANSWER, partial=>{
      setThread(p=>p.map(ex=>ex.id===exId?{
        ...ex, btws:ex.btws.map(b=>b.id===btwId?{...b,streamText:partial}:b)
      }:ex));
    }, ()=>{
      setThread(p=>p.map(ex=>ex.id===exId?{
        ...ex, btws:ex.btws.map(b=>b.id===btwId?{
          ...b, streaming:false, streamText:undefined,
          messages:[{role:"assistant",text:BTW_ANSWER}]
        }:b)
      }:ex));
    }, 4);
    return () => clearInterval(iv);
  }, [popover]);

  const handleBtwReply = useCallback((btwId, userText) => {
    setThread(p=>p.map(ex=>({
      ...ex, btws:ex.btws.map(b=>b.id===btwId
        ?{...b,streaming:true,streamText:"",messages:[...b.messages,{role:"user",text:userText}]}
        :b)
    })));
    const iv = streamInterval(BTW_REPLY, partial=>{
      setThread(p=>p.map(ex=>({...ex,btws:ex.btws.map(b=>b.id===btwId?{...b,streamText:partial}:b)})));
    }, ()=>{
      setThread(p=>p.map(ex=>({
        ...ex, btws:ex.btws.map(b=>b.id===btwId?{
          ...b, streaming:false, streamText:undefined,
          messages:[...b.messages,{role:"assistant",text:BTW_REPLY}]
        }:b)
      })));
    }, 4);
    return () => clearInterval(iv);
  }, []);

  const togglePanel = a => setPanelArt(p=>p===a?null:a);

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <div className="main">

          {/* Top bar */}
          <div className={`sw ${isActive?"sw-top":"sw-mid"}`}>
            {!isActive && <div className="wm">ARCHIVE — KNOWLEDGE BASE</div>}
            <div className={`bar ${isActive?"bar-full":""}`}>
              <input ref={barRef} className="bar-in"
                placeholder="Ask a question across the knowledge base…"
                value={query} onChange={e=>setQuery(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
                disabled={phase!=="idle"} autoFocus/>
              {isActive&&<button className="bar-clr" onClick={handleReset}>clear</button>}
              <button className="bar-go" onClick={handleSubmit}
                disabled={phase!=="idle"||!query.trim()}>
                {phase==="idle"?"QUERY":"WORKING"}
              </button>
            </div>
            {!isActive&&<div className="hint">return to submit · select text to follow up or digress</div>}
          </div>

          {/* Thread */}
          <div className="thread" ref={threadRef}>
            <div className="thread-in">
              {thread.map((ex,ei)=>(
                <div key={ex.id} className={`ex ${ei>0?"ex-sep":""}`}>
                  <div className="ex-hd">
                    <span className="qecho">"{ex.query}"</span>
                    {ei===thread.length-1&&canFu&&(
                      <button className={`savebtn ${saved?"saved":""}`}
                        onClick={()=>setSaved(true)} disabled={saved}>
                        <span className="sdot"/>{saved?"saved":"save to wiki"}
                      </button>
                    )}
                  </div>
                  <SourceCards cards={ex.cards} active={panelArt} onPick={togglePanel}/>
                  <AnswerBlock text={ex.answer} exId={ex.id} btws={ex.btws}
                    onBtwReply={handleBtwReply} streaming={false} onSel={handleSel}/>
                </div>
              ))}

              {(phase==="searching"||phase==="streaming")&&(
                <div className={`ex ${thread.length>0?"ex-sep":""}`}>
                  {phase==="searching"&&liveCards.length===0&&(
                    <div className="trav">traversing knowledge base…</div>
                  )}
                  <SourceCards cards={liveCards} active={panelArt} onPick={togglePanel}/>
                  {liveText&&(
                    <AnswerBlock text={liveText} exId="live" btws={[]}
                      onBtwReply={()=>{}} streaming={true} onSel={()=>{}}/>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Follow-up bar */}
          {canFu&&(
            <div className="fu-bar">
              {chips.length>0&&(
                <div className="chips">
                  {chips.map((c,i)=>(
                    <div key={i} className="chip">
                      <span className="chip-txt">"{c.length>42?c.slice(0,42)+"…":c}"</span>
                      <button className="chip-x" onClick={()=>setChips(p=>p.filter((_,j)=>j!==i))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="fu-row">
                <input className="fu-in"
                  placeholder={chips.length>0?"add context or submit selections…":"follow up…"}
                  value={fuInput} onChange={e=>setFuInput(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"&&(chips.length>0||fuInput.trim())) handleFU(); }}/>
                <button className="fu-go" onClick={handleFU}
                  disabled={chips.length===0&&!fuInput.trim()}>FOLLOW UP</button>
              </div>
            </div>
          )}
        </div>

        {/* Selection popover */}
        {popover&&(
          <div className="pop" style={{left:popover.x,top:popover.y}}>
            <button className="pbtn" onClick={handleAddChip}>+ follow up</button>
            <button className="pbtn pbtw" onClick={handleBtw}>btw</button>
          </div>
        )}

        {/* Article panel overlay */}
        {panelArt&&<ArticlePanel article={panelArt} onClose={()=>setPanelArt(null)}/>}
      </div>
    </>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0c0c0c;color:#e0d8c8;font-family:'Libre Baskerville',Georgia,serif;min-height:100vh;overflow:hidden}

.app{display:flex;height:100vh;overflow:hidden;position:relative}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}

/* Search */
.sw{flex-shrink:0;display:flex;flex-direction:column;align-items:center;padding:0 40px;transition:all .44s cubic-bezier(.4,0,.2,1)}
.sw-mid{flex:1;justify-content:center;padding-bottom:72px}
.sw-top{padding-top:22px;padding-bottom:18px;border-bottom:1px solid #181818}
.wm{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.26em;text-transform:uppercase;color:#3a3020;margin-bottom:40px}
.hint{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;color:#221a10;margin-top:16px}
.bar{width:100%;max-width:640px;display:flex;align-items:center;background:#111;border:1px solid #221a0e;border-radius:3px;overflow:hidden;transition:max-width .4s cubic-bezier(.4,0,.2,1)}
.bar:focus-within{border-color:#4a3820}
.bar-full{max-width:100%;border-radius:2px}
.bar-in{flex:1;background:transparent;border:none;outline:none;color:#e0d8c8;font-family:'Libre Baskerville',serif;font-size:14.5px;padding:13px 18px;caret-color:#c9a96e}
.bar-in::placeholder{color:#2a2010}
.bar-clr{background:transparent;border:none;color:#332a1a;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.08em;padding:13px 12px;cursor:pointer;transition:color .2s}
.bar-clr:hover{color:#7a6040}
.bar-go{background:#c9a96e;border:none;color:#0c0c0c;font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:500;letter-spacing:.12em;padding:13px 18px;cursor:pointer;transition:background .18s;white-space:nowrap}
.bar-go:hover{background:#dbbf84}
.bar-go:disabled{background:#1a1a1a;color:#2a2a2a;cursor:default}

/* Thread */
.thread{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#1a1a1a transparent}
.thread-in{padding:28px 40px 20px;max-width:740px}
.ex{}
.ex-sep{border-top:1px solid #141414;margin-top:36px;padding-top:32px}
.ex-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.qecho{font-style:italic;font-size:12.5px;color:#4a3e2a}
.savebtn{background:transparent;border:1px solid #1c1c1c;color:#4a4030;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;padding:5px 12px;border-radius:2px;cursor:pointer;transition:all .18s;display:flex;align-items:center;gap:5px}
.savebtn:hover:not(.saved){border-color:#4a3820;color:#c9a96e}
.saved{border-color:#1e3a1e;color:#5a8a5a;cursor:default}
.sdot{width:4px;height:4px;border-radius:50%;background:currentColor}

/* Cards */
.cards{margin-bottom:18px}
.cards-exp{}
.cards-col{display:flex;align-items:center}
.cards-row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}
.card{background:#0f0f0f;border:1px solid #1c1c1c;border-radius:2px;padding:5px 11px;font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#5a4e3c;letter-spacing:.06em;cursor:pointer;transition:all .16s;animation:cardIn .26s ease both;white-space:nowrap}
.card:hover{border-color:#4a3820;color:#c9a96e}
.card-on{border-color:#4a3820;color:#c9a96e;background:#100e08}
@keyframes cardIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.tog{background:none;border:none;color:#2e2418;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;cursor:pointer;display:flex;align-items:center;gap:6px;transition:color .2s;padding:3px 0}
.tog:hover{color:#6a5030}
.tog-dots{display:flex;gap:3px}
.tog-dot{width:10px;height:2px;background:#222;border-radius:1px}

/* Markdown */
.md{user-select:text}
.md-h2{font-size:16.5px;font-weight:700;color:#e0d8c8;margin:26px 0 11px;letter-spacing:-.01em}
.md-h2:first-child{margin-top:0}
.md-h3{font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:500;color:#c9a96e;margin:18px 0 8px;letter-spacing:.14em;text-transform:uppercase}
.md-p{font-size:14px;line-height:1.82;color:#b0a898;margin-bottom:2px}
.md-p em{color:#d8d0c0}
.md-gap{height:9px}
.cur{display:inline-block;width:2px;height:13px;background:#c9a96e;animation:blink 1s step-end infinite;vertical-align:middle;margin-left:1px}
.cur-s{display:inline-block;width:1px;height:10px;background:#7a6040;animation:blink 1s step-end infinite;vertical-align:middle;margin-left:1px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.trav{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.12em;color:#3a3020;animation:pulse 1.6s ease-in-out infinite;padding:4px 0 16px}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}

/* BTW */
.btw{margin:10px 0 12px;border-left:2px solid #2a1e0e;padding-left:14px}
.btw-hd{display:flex;align-items:baseline;gap:8px;background:none;border:none;cursor:pointer;width:100%;padding:0 0 7px;text-align:left}
.btw-lbl{font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:.16em;color:#c9a96e;text-transform:uppercase;flex-shrink:0}
.btw-anc{font-style:italic;font-size:11px;color:#4a3e2a;flex:1}
.btw-chv{font-family:'JetBrains Mono',monospace;font-size:8px;color:#2e2216;flex-shrink:0}
.btw-bd{}
.bm{font-size:12.5px;line-height:1.72;margin-bottom:9px}
.bm-assistant{color:#9a9080}
.bm-user{color:#6a5a48;font-style:italic}
.bm-you{font-family:'JetBrains Mono',monospace;font-style:normal;font-size:8.5px;letter-spacing:.1em;color:#3a2e1e;margin-right:2px}
.btw-inp-row{margin-top:5px}
.btw-inp{background:transparent;border:none;border-bottom:1px solid #241c0e;outline:none;color:#7a6a58;font-family:'Libre Baskerville',serif;font-style:italic;font-size:12px;padding:3px 0;width:100%;caret-color:#c9a96e}
.btw-inp::placeholder{color:#2a1e10}

/* Popover */
.pop{position:fixed;transform:translate(-50%,-100%);background:#181208;border:1px solid #3a2810;border-radius:3px;display:flex;overflow:hidden;z-index:300;box-shadow:0 6px 24px rgba(0,0,0,.7);animation:popIn .14s ease;margin-top:-6px}
@keyframes popIn{from{opacity:0;transform:translate(-50%,-88%)}to{opacity:1;transform:translate(-50%,-100%)}}
.pbtn{background:none;border:none;color:#8a7a60;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;padding:9px 14px;cursor:pointer;transition:all .14s;white-space:nowrap}
.pbtn:hover{background:#221608;color:#c9a96e}
.pbtn+.pbtn{border-left:1px solid #2a1e0e}
.pbtw{color:#6a8a60}
.pbtw:hover{color:#8aba78;background:#0e1a0a}

/* Follow-up bar */
.fu-bar{flex-shrink:0;border-top:1px solid #161616;padding:12px 40px 14px;display:flex;flex-direction:column;gap:8px;animation:slideUp .28s cubic-bezier(.4,0,.2,1)}
@keyframes slideUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{background:#100e08;border:1px solid #3a2810;border-radius:2px;padding:4px 9px 4px 11px;font-style:italic;font-size:11px;color:#7a6848;display:flex;align-items:center;gap:7px;max-width:280px}
.chip-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.chip-x{background:none;border:none;color:#3a2810;cursor:pointer;font-size:13px;line-height:1;padding:0;transition:color .14s;flex-shrink:0}
.chip-x:hover{color:#9a7040}
.fu-row{display:flex;align-items:center}
.fu-in{flex:1;background:transparent;border:none;outline:none;color:#c0b8a8;font-family:'Libre Baskerville',serif;font-size:13.5px;padding:3px 0;caret-color:#c9a96e}
.fu-in::placeholder{color:#221a0e}
.fu-go{background:transparent;border:1px solid #1e1810;border-radius:2px;color:#5a4e38;font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:.1em;padding:7px 13px;cursor:pointer;transition:all .18s;white-space:nowrap;margin-left:14px}
.fu-go:hover:not(:disabled){border-color:#4a3820;color:#c9a96e}
.fu-go:disabled{opacity:.25;cursor:default}

/* Panel */
.panel{position:fixed;top:0;right:0;width:370px;height:100vh;background:#0e0e0e;border-left:1px solid #181818;display:flex;flex-direction:column;z-index:200;box-shadow:-24px 0 60px rgba(0,0,0,.6);animation:panelIn .28s cubic-bezier(.4,0,.2,1)}
@keyframes panelIn{from{transform:translateX(16px);opacity:0}to{transform:none;opacity:1}}
.panel-hd{padding:20px 20px 14px;border-bottom:1px solid #181818;flex-shrink:0}
.ptitle-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:9px}
.ptitle{font-size:14.5px;font-weight:700;color:#e0d8c8}
.xbtn{background:none;border:none;color:#2e2a28;font-size:17px;cursor:pointer;transition:color .18s;padding:0 0 0 10px;flex-shrink:0}
.xbtn:hover{color:#8a7a6a}
.pmeta{display:flex;gap:7px;margin-bottom:8px}
.pill{font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:.1em;padding:3px 8px;border-radius:2px}
.pill-t{background:#100e08;color:#c9a96e;border:1px solid #241c0e}
.pill-d{background:#101010;color:#3e3a30;border:1px solid #1a1a1a}
.ptags{display:flex;flex-wrap:wrap;gap:5px}
.ptag{font-family:'JetBrains Mono',monospace;font-size:8.5px;color:#2e2a22;letter-spacing:.06em}
.panel-bd{flex:1;overflow-y:auto;padding:18px 20px;scrollbar-width:thin;scrollbar-color:#1a1a1a transparent}
.panel-bd p{font-size:12.5px;line-height:1.76;color:#9a9080;margin-bottom:13px}
`;
