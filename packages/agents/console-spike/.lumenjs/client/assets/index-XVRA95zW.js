const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/console-DfLNiHy7.js","assets/__nk_build_index-cfUmou0i.js"])))=>i.map(i=>d[i]);
import{b as n,_ as r}from"./__nk_build_index-cfUmou0i.js";import{i as p,a as h}from"./lit-element-q29aEJBI.js";r(()=>import("./console-DfLNiHy7.js").then(t=>t.a),__vite__mapDeps([0,1]));function l({push:t}){let i=0;const o=setInterval(()=>{i+=1,t({pushedTitle:`pushed title #${i}`,pushedAt:new Date().toISOString()})},1e3);return()=>clearInterval(o)}const e=class e extends p{constructor(){super(...arguments),this.pushedTitle="",this.pushedAt=""}render(){return n`
      <agent-console></agent-console>
      <div class="socket-probe" data-testid="socket-probe">
        ${this.pushedTitle?`${this.pushedTitle} @ ${this.pushedAt}`:"socket: waiting"}
      </div>
    `}};e.properties={pushedTitle:{type:String},pushedAt:{type:String}},e.styles=h`
    /* The last link in the height chain — see head.html. The probe below is
       position:fixed, so it needs no positioned ancestor. */
    :host { display: block; height: 100%; }
    /* A spike-only readout. Nothing like it survives into phase 3 — the
       pushed title lands on the sidebar row there. It is fixed and tiny so
       it cannot disturb the console's own layout while both are on screen. */
    .socket-probe {
      position: fixed; right: 8px; bottom: 8px; z-index: 9999;
      font: 11px/1.4 ui-monospace, monospace;
      background: rgba(0,0,0,.8); color: #fff;
      padding: 4px 8px; border-radius: 6px;
    }
  `;let s=e;customElements.get("page-index")||customElements.define("page-index",s);export{s as PageIndex,l as socket};
