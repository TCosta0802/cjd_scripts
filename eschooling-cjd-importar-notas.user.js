// ==UserScript==
// @name         E-Schooling CJD — Importar Notas do Excel
// @namespace    https://eschooling.colegiojuliodinis.pt/
// @version      6.1
// @description  Importa notas; perfis reutilizáveis entre turmas/turnos; suporta PT, Cambridge, numérica e listas
// @author       CJD IT
// @match        https://eschooling.colegiojuliodinis.pt/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/TCosta0802/cjd_scripts/main/cjd-importar-notas.user.js
// @downloadURL  https://raw.githubusercontent.com/TCosta0802/cjd_scripts/main/cjd-importar-notas.user.js
// ==/UserScript==

(function () {
    'use strict';

    const BTN_ID    = 'cjd-import-btn';
    const MODAL_ID  = 'cjd-import-modal';
    const STORE_KEY = 'cjd_notas_perfis';   // localStorage

    /* ══════════════════════════════════════════════════════════════
       1. GESTÃO DE PERFIS  (localStorage)
    ══════════════════════════════════════════════════════════════ */
    const Perfis = {
        todos()        { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); },
        guardar(arr)   { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); },
        adicionar(p)   {
            const arr = this.todos();
            arr.unshift(p);
            if (arr.length > 30) arr.length = 30;   // máx. 30 perfis
            this.guardar(arr);
        },
        apagar(id)     { this.guardar(this.todos().filter(p => p.id !== id)); },
    };

    function criarPerfil(nome, linhasBrutas, nomesPage) {
        const notas = linhasBrutas.map((raw, i) => ({
            nome: (nomesPage[i] || '').trim(),
            nota: normalizarNota(raw) ?? raw.trim()
        }));
        const now = new Date();
        return {
            id:    `${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            nome:  nome.trim() || `Perfil ${now.toLocaleDateString('pt-PT')}`,
            data:  now.toLocaleString('pt-PT', {
                       day:'2-digit',month:'2-digit',year:'numeric',
                       hour:'2-digit',minute:'2-digit'
                   }),
            notas   // [{ nome: string, nota: string }]
        };
    }

    /* ══════════════════════════════════════════════════════════════
       2. NORMALIZAÇÃO DE NOTAS
       ─────────────────────────────────────────────────────────────
       Sistemas suportados:
         PT Qualitativa : F · I · S · B · MB   (select ou texto)
         Cambridge      : A* · A · B · C · D · E · F · G · U
         Numérica texto : 0–100 inteiros (decimais arredondados)
         Lista numérica : 1–5, 0–20, etc. (select, arredondado)
    ══════════════════════════════════════════════════════════════ */
    const QUALITATIVAS_PT       = ['F', 'I', 'S', 'B', 'MB'];
    const QUALITATIVAS_CAMBRIDGE = ['A*', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'U'];
    // União de todos os códigos qualitativos reconhecidos (para normalizarNota)
    const QUALITATIVAS_TODAS    = [...new Set([...QUALITATIVAS_PT, ...QUALITATIVAS_CAMBRIDGE])];
    // ['F','I','S','B','MB','A*','A','C','D','E','G','U']  — 'B' e 'F' partilhados

    function normalizarNota(raw) {
        const v = raw.trim().replace(/\t/g, '');
        if (v === '') return null;
        if (QUALITATIVAS_TODAS.includes(v.toUpperCase())) return v.toUpperCase();
        if (/^[\d]+([,.]\d+)?$/.test(v)) return v.replace(',', '.');
        return v;  // texto livre desconhecido — passa tal como está
    }
    function notaParaInput(interno) {
        const n = parseFloat(interno);
        return isNaN(n) ? interno : String(Math.round(n));  // qualitativas → fica; números → inteiro
    }
    function notaParaSelect(interno) {
        const n = parseFloat(interno);
        return isNaN(n) ? interno : String(Math.round(n));
    }

    /* ══════════════════════════════════════════════════════════════
       3. CORRESPONDÊNCIA DE NOMES  (fuzzy, word-overlap)
    ══════════════════════════════════════════════════════════════ */
    function norm(s) {
        return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().trim().replace(/\s+/g, ' ');
    }
    function sim(a, b) {
        const wa = norm(a).split(' ').filter(Boolean);
        const wb = norm(b).split(' ').filter(Boolean);
        if (!wa.length || !wb.length) return 0;
        return wa.filter(w => wb.includes(w)).length / Math.max(wa.length, wb.length);
    }

    // Mapeia notas do perfil para a ordem dos alunos da página atual
    // Devolve [{nomeEsc, nomePerf, nota, confianca}] na ordem da página
    function mapearPerfilParaPagina(perfilNotas, nomesPage) {
        return nomesPage.map(nomeEsc => {
            let melhorNota = '', melhorNome = '', melhorSim = 0;
            perfilNotas.forEach(({ nome: nomePerf, nota }) => {
                if (!nomePerf) return;
                const s = sim(nomeEsc, nomePerf);
                if (s > melhorSim) { melhorSim = s; melhorNota = nota; melhorNome = nomePerf; }
            });
            const conf = melhorSim >= 0.99 ? 2 : melhorSim >= 0.6 ? 1 : 0;
            return { nomeEsc, nomePerf: conf > 0 ? melhorNome : '', nota: conf > 0 ? melhorNota : '', confianca: conf };
        });
    }

    /* ══════════════════════════════════════════════════════════════
       4. DETECÇÃO DOS CAMPOS  (enhanced: captura também nomes)
    ══════════════════════════════════════════════════════════════ */
    function encontrarColunasDeNota() {
        const res = [];

        document.querySelectorAll('table').forEach(tabela => {
            const hRow = tabela.querySelector('tr:first-child');
            if (!hRow) return;
            const headers = [...hRow.querySelectorAll('th, td')];

            // Índice da coluna de nomes (se existir)
            let nomeIdx = -1;
            headers.forEach((th, i) => {
                if (/nome|aluno/i.test(th.textContent.trim())) nomeIdx = i;
            });

            headers.forEach((th, colIdx) => {
                if (!/nota/i.test(th.textContent.trim())) return;
                const inputs = [], nomes = [];

                [...tabela.querySelectorAll('tr')].slice(1).forEach(tr => {
                    const cels  = [...tr.querySelectorAll('td')];
                    const campo = cels[colIdx]?.querySelector(
                        'input[type="text"], input:not([type]), select');
                    if (!campo || !campo.offsetParent) return;
                    inputs.push(campo);
                    nomes.push(nomeIdx >= 0 ? (cels[nomeIdx]?.textContent.trim() || '') : '');
                });

                if (inputs.length > 0) {
                    res.push({
                        coluna: th.textContent.trim() || `Coluna ${colIdx + 1}`,
                        inputs,
                        tipo:  detectarTipo(inputs),
                        nomes   // ← novo: nomes dos alunos (pode ser '' se não encontrado)
                    });
                }
            });
        });

        // Fallback
        if (res.length === 0) {
            const fallback = [
                ...document.querySelectorAll(
                    'table input[type="text"], table input:not([type]), table select')
            ].filter(el => el.offsetParent);
            if (fallback.length > 0) {
                res.push({
                    coluna: 'Nota (detetado automaticamente)',
                    inputs: fallback,
                    tipo:   detectarTipo(fallback),
                    nomes:  fallback.map(() => '')
                });
            }
        }
        return res;
    }

    function detectarTipo(campos) {
        const p = campos[0];
        if (!p) return 'texto';
        if (p.tagName === 'SELECT') {
            const opts = [...p.options]
                .map(o => o.text.trim())
                .filter(t => t && !/escolher|selecionar|^-/i.test(t));

            // Cambridge: tem A* ou tem qualquer código exclusivo de Cambridge (C, D, E, G, U)
            // ('A','B','F' são partilhados com PT — usamos os exclusivos para desambiguar)
            const exclusivasCambridge = ['A*', 'C', 'D', 'E', 'G', 'U'];
            if (opts.some(o => exclusivasCambridge.includes(o.toUpperCase()))) {
                return 'cambridge';
            }

            // PT Qualitativa: todas as opções são F / I / S / B / MB
            if (opts.length > 0 && opts.every(o => QUALITATIVAS_PT.includes(o.toUpperCase()))) {
                return 'qualitativa';
            }

            // Lista numérica (1–5, 0–20, etc.)
            const nums = opts.map(Number).filter(n => !isNaN(n));
            if (nums.length > 0) return `select-${Math.min(...nums)}-${Math.max(...nums)}`;

            return 'select';
        }
        return 'texto';
    }
    function descricaoTipo(tipo) {
        if (tipo === 'qualitativa') return '🔤 PT Qualitativa  (F / I / S / B / MB)';
        if (tipo === 'cambridge')   return '🎓 Cambridge  (A* / A / B / C / D / E / F / G / U)';
        if (tipo === 'texto')       return '✏️ Numérica  (inteiros 0–100 — decimais arredondados: 97,5 → 98)';
        if (tipo.startsWith('select-')) {
            const [, mn, mx] = tipo.split('-');
            return `🔢 Lista  ${mn} a ${mx}  — decimais arredondados automaticamente`;
        }
        return tipo;
    }

    /* ══════════════════════════════════════════════════════════════
       5. PREENCHIMENTO  (v5.1 unchanged + variante por mapeamento)
    ══════════════════════════════════════════════════════════════ */
    function preencherNotas(campos, linhasBrutas) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        let preenchidos = 0, ignorados = 0;
        const notas = linhasBrutas.map(normalizarNota).filter(v => v !== null);

        notas.forEach((nota, i) => {
            const campo = campos[i];
            if (!campo) return;
            if (campo.tagName === 'SELECT') {
                const procurar = notaParaSelect(nota);
                const opcao = [...campo.options].find(o =>
                    o.text.trim().toUpperCase() === procurar.toUpperCase() ||
                    o.value.trim().toUpperCase() === procurar.toUpperCase()
                );
                if (opcao) {
                    campo.value = opcao.value;
                    ['change','blur'].forEach(e => campo.dispatchEvent(new Event(e, { bubbles:true })));
                    preenchidos++;
                } else { ignorados++; }
            } else {
                setter.call(campo, notaParaInput(nota));
                ['input','change','blur'].forEach(e => campo.dispatchEvent(new Event(e, { bubbles:true })));
                preenchidos++;
            }
        });
        return { preenchidos, ignorados };
    }

    // Variante usada ao aplicar perfis por nome: cada entrada do mapeamento → campo correspondente
    function preencherPorMapeamento(campos, mapeamento) {
        let preenchidos = 0, ignorados = 0;
        mapeamento.forEach((m, i) => {
            if (!campos[i] || m.confianca === 0 || !m.nota) return;
            const r = preencherNotas([campos[i]], [m.nota]);
            preenchidos += r.preenchidos;
            ignorados   += r.ignorados;
        });
        return { preenchidos, ignorados };
    }

    /* ══════════════════════════════════════════════════════════════
       6. BOTÃO FLUTUANTE
    ══════════════════════════════════════════════════════════════ */
    function textoBtn() {
        const n = Perfis.todos().length;
        return n > 0 ? `📋 Importar Notas  ·  📁 ${n}` : '📋 Importar Notas';
    }

    function injetarBotao() {
        if (document.getElementById(BTN_ID)) return;
        const colunas = encontrarColunasDeNota();
        if (colunas.length === 0) return;

        const btn = document.createElement('button');
        btn.id          = BTN_ID;
        btn.type        = 'button';
        btn.innerHTML   = textoBtn();
        btn.title       = `${colunas.reduce((s,c) => s + c.inputs.length, 0)} campo(s) de nota detetados`;
        btn.style.cssText = [
            'position:fixed','bottom:20px','right:20px','z-index:9998',
            'background:#1565C0','color:#fff','border:none','border-radius:8px',
            'padding:10px 18px','font-size:14px','font-weight:700','cursor:pointer',
            'box-shadow:0 4px 16px rgba(0,0,0,.3)','transition:background .15s',
        ].join(';');
        btn.addEventListener('mouseenter', () => btn.style.background = '#0D47A1');
        btn.addEventListener('mouseleave', () => btn.style.background = '#1565C0');
        btn.addEventListener('click',      () => abrirModal(colunas));
        document.body.appendChild(btn);
    }

    /* ══════════════════════════════════════════════════════════════
       7. MODAL
    ══════════════════════════════════════════════════════════════ */
    function abrirModal(colunas) {
        if (document.getElementById(MODAL_ID)) return;

        const selectorHTML = colunas.length > 1
            ? `<label style="font-size:12px;color:#555;display:block;margin-bottom:4px;">Coluna a preencher:</label>
               <select id="cjd-col-select" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:5px;font-size:13px;margin-bottom:6px;">
                   ${colunas.map((c, i) => `<option value="${i}">${c.coluna} — ${c.inputs.length} aluno(s)</option>`).join('')}
               </select>`
            : `<p style="font-size:12px;color:#555;margin:0 0 4px;"><strong>${colunas[0].coluna}</strong> — ${colunas[0].inputs.length} aluno(s)</p>`;

        const overlay = document.createElement('div');
        overlay.id    = MODAL_ID;
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;';

        overlay.innerHTML = `
<div style="background:#fff;border-radius:12px;width:500px;max-height:92vh;display:flex;flex-direction:column;
            box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:sans-serif;overflow:hidden;">

    <!-- Cabeçalho -->
    <div style="background:#1565C0;color:#fff;padding:14px 18px;display:flex;
                justify-content:space-between;align-items:center;flex-shrink:0;">
        <h3 style="margin:0;font-size:15px;">📋 Importar Notas do Excel</h3>
        <button id="cjd-x" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;opacity:.8;">✕</button>
    </div>

    <!-- Corpo com scroll -->
    <div style="overflow-y:auto;padding:18px;flex:1;">

        ${selectorHTML}
        <div id="cjd-tipo-badge"
             style="font-size:11px;color:#1565C0;background:#E3F2FD;
                    border-radius:6px;padding:5px 10px;margin-bottom:12px;"></div>

        <label style="font-size:12px;color:#555;display:block;margin-bottom:5px;">
            Copia a coluna de notas no Excel <strong>(Ctrl+C)</strong> e cola aqui <strong>(Ctrl+V)</strong>:
        </label>
        <textarea id="cjd-notas" rows="11"
            style="width:100%;box-sizing:border-box;font-family:monospace;font-size:13px;
                   border:1px solid #ccc;border-radius:6px;padding:8px;resize:vertical;"
            placeholder="PT Qualitativa:   MB  B  S  I  F&#10;Cambridge:        A*  A  B  C  D  E  U&#10;Numérica 0–100:   90  14  3&#10;(uma nota por linha)"></textarea>
        <p style="font-size:11px;color:#aaa;margin:4px 0 12px;">
            Uma nota por linha · A ordem tem de corresponder à lista de alunos
        </p>

        <!-- ── GUARDAR COMO PERFIL ──────────────────────────── -->
        <div style="display:flex;gap:6px;margin-bottom:14px;align-items:center;">
            <input id="cjd-perfil-nome" type="text"
                placeholder="Nome do perfil para reutilizar (ex: Teste 1 — 8E)"
                style="flex:1;padding:7px 8px;border:1px solid #ccc;border-radius:6px;
                       font-size:12px;min-width:0;">
            <button id="cjd-perfil-guardar" title="Guardar estas notas como perfil reutilizável"
                style="background:#2E7D32;color:#fff;border:none;border-radius:6px;
                       padding:7px 12px;font-size:13px;font-weight:700;cursor:pointer;
                       white-space:nowrap;flex-shrink:0;">💾 Guardar</button>
        </div>

        <!-- ── PERFIS GUARDADOS ─────────────────────────────── -->
        <details id="cjd-perfis-details" style="margin-bottom:14px;">
            <summary style="cursor:pointer;user-select:none;list-style:none;
                padding:9px 12px;background:#f0f4ff;border-radius:7px;
                display:flex;justify-content:space-between;align-items:center;">
                <span id="cjd-perfis-title" style="font-size:13px;color:#1565C0;font-weight:700;"></span>
                <span style="font-size:11px;color:#aaa;">▼</span>
            </summary>
            <div id="cjd-perfis-lista" style="margin-top:8px;"></div>
        </details>

        <!-- ── AÇÕES ────────────────────────────────────────── -->
        <div style="display:flex;gap:8px;margin-bottom:10px;">
            <button id="cjd-importar"
                style="flex:1;background:#2E7D32;color:#fff;border:none;padding:11px;
                       border-radius:7px;cursor:pointer;font-size:14px;font-weight:700;">
                ✅ Importar
            </button>
            <button id="cjd-limpar"
                style="background:#E64A19;color:#fff;border:none;padding:11px 14px;
                       border-radius:7px;cursor:pointer;font-size:18px;" title="Limpar">🗑</button>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#444;
                      cursor:pointer;margin-bottom:8px;">
            <input type="checkbox" id="cjd-autosave" style="width:14px;height:14px;">
            Clicar automaticamente em "Guardar" após importar
        </label>

        <div id="cjd-status" style="font-size:13px;min-height:18px;font-weight:600;"></div>
    </div>
</div>`;

        document.body.appendChild(overlay);

        /* helpers */
        const setStatus = (msg, cor = '#333') => {
            const el = overlay.querySelector('#cjd-status');
            el.textContent = msg;
            el.style.color = cor;
        };
        const colAtual = () => {
            const idx = parseInt(overlay.querySelector('#cjd-col-select')?.value ?? '0');
            return colunas[idx];
        };
        const dispararGuardar = () => {
            const btns = [...document.querySelectorAll('input[type="image"],input[type="submit"],button')]
                .filter(b => /guardar|salvar|save/i.test([b.value, b.textContent, b.title, b.alt].join(' ')));
            if (btns.length) setTimeout(() => btns.forEach(b => b.click()), 400);
        };
        const refreshBtnMain = () => {
            const b = document.getElementById(BTN_ID);
            if (b) b.innerHTML = textoBtn();
        };

        /* tipo badge */
        const atualizarBadge = () => {
            const badge = overlay.querySelector('#cjd-tipo-badge');
            if (badge) badge.textContent = descricaoTipo(colAtual().tipo);
        };
        overlay.querySelector('#cjd-col-select')?.addEventListener('change', () => {
            atualizarBadge(); renderizarPerfis();
        });
        atualizarBadge();

        /* ── RENDER PERFIS ─────────────────────────────────── */
        function renderizarPerfis() {
            const lista  = overlay.querySelector('#cjd-perfis-lista');
            const title  = overlay.querySelector('#cjd-perfis-title');
            const todos  = Perfis.todos();
            title.textContent = todos.length > 0
                ? `📁 Perfis guardados (${todos.length})`
                : `📁 Perfis guardados`;

            if (todos.length === 0) {
                lista.innerHTML = `<p style="font-size:12px;color:#aaa;text-align:center;padding:12px 0;">
                    Nenhum perfil ainda.<br>
                    <small>Cola as notas e clica em 💾 para guardar.</small></p>`;
                return;
            }

            lista.innerHTML = todos.map(p => {
                const prev  = p.notas.slice(0, 5).map(n => n.nota || '—').join(' · ');
                const extra = p.notas.length > 5 ? ` +${p.notas.length - 5}` : '';
                return `
<div class="cjd-card" data-id="${p.id}"
    style="border:1px solid #e0e6f0;border-radius:8px;padding:10px 12px;
           margin-bottom:6px;background:#fafcff;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;color:#1565C0;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                title="${p.nome}">${p.nome}</div>
            <div style="font-size:11px;color:#aaa;margin-top:2px;">${p.data} · ${p.notas.length} aluno(s)</div>
            <div style="font-size:11px;color:#777;font-family:monospace;margin-top:2px;">${prev}${extra}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;align-items:flex-start;">
            <button class="cjd-btn-carregar" data-id="${p.id}"
                style="background:#1565C0;color:#fff;border:none;padding:5px 11px;
                       border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;">
                ▶ Carregar
            </button>
            <button class="cjd-btn-apagar" data-id="${p.id}"
                style="background:none;border:1px solid #e0e0e0;color:#ccc;padding:5px 8px;
                       border-radius:5px;cursor:pointer;font-size:13px;" title="Apagar">🗑</button>
        </div>
    </div>
    <!-- Preview inline (escondido até "Carregar") -->
    <div class="cjd-prev-box" data-id="${p.id}" style="display:none;margin-top:10px;"></div>
</div>`;
            }).join('');

            /* apagar */
            lista.querySelectorAll('.cjd-btn-apagar').forEach(btn =>
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    const p = Perfis.todos().find(x => x.id === btn.dataset.id);
                    if (!p) return;
                    if (!confirm(`Apagar o perfil "${p.nome}"?`)) return;
                    Perfis.apagar(p.id);
                    renderizarPerfis();
                    refreshBtnMain();
                })
            );

            /* carregar */
            lista.querySelectorAll('.cjd-btn-carregar').forEach(btn =>
                btn.addEventListener('click', () => {
                    const p       = Perfis.todos().find(x => x.id === btn.dataset.id);
                    if (!p) return;
                    const box     = lista.querySelector(`.cjd-prev-box[data-id="${p.id}"]`);
                    const col     = colAtual();
                    const temPerf = p.notas.some(n => n.nome);
                    const temPage = col.nomes.some(n => n !== '');

                    // Fecha outros previews abertos
                    lista.querySelectorAll('.cjd-prev-box').forEach(b => {
                        if (b !== box) b.style.display = 'none';
                    });

                    if (temPerf && temPage) {
                        /* ── CORRESPONDÊNCIA POR NOME ── */
                        const mapeamento = mapearPerfilParaPagina(p.notas, col.nomes);
                        const exact = mapeamento.filter(m => m.confianca === 2).length;
                        const fuzzy = mapeamento.filter(m => m.confianca === 1).length;
                        const none  = mapeamento.filter(m => m.confianca === 0).length;

                        const linhas = mapeamento.map(m => {
                            const icon = m.confianca === 2 ? '✅' : m.confianca === 1 ? '🟡' : '❌';
                            const bg   = m.confianca === 1 ? 'background:#FFFDE7;' :
                                         m.confianca === 0 ? 'background:#FFEBEE;' : '';
                            return `<tr style="${bg}">
                                <td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;font-size:11px;">${m.nomeEsc}</td>
                                <td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;font-size:11px;color:#555;">${m.nomePerf || '<em style="color:#ccc">—</em>'}</td>
                                <td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;font-size:11px;font-weight:700;color:#1565C0;text-align:center;">${m.nota || '<em style="color:#ccc">—</em>'}</td>
                                <td style="padding:3px 8px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:center;">${icon}</td>
                            </tr>`;
                        }).join('');

                        box.innerHTML = `
<div style="background:#f8f9fc;border:1px solid #e0e6f0;border-radius:7px;padding:10px;">
    <!-- Resumo chips -->
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;align-items:center;">
        <span style="font-size:11px;font-weight:700;color:#333;">Correspondência:</span>
        <span style="background:#E8F5E9;color:#2E7D32;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">✅ Exato: ${exact}</span>
        ${fuzzy > 0 ? `<span style="background:#FFF8E1;color:#E65100;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">🟡 Parcial: ${fuzzy}</span>` : ''}
        ${none  > 0 ? `<span style="background:#FFEBEE;color:#C62828;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">❌ Não encontrado: ${none}</span>` : ''}
    </div>
    <!-- Tabela colapsável -->
    <details>
        <summary style="font-size:11px;color:#888;cursor:pointer;margin-bottom:6px;">
            Ver detalhe ▼
        </summary>
        <div style="overflow-y:auto;max-height:170px;border-radius:5px;overflow:hidden;">
            <table style="border-collapse:collapse;width:100%;">
                <thead>
                    <tr style="background:#eef1f8;position:sticky;top:0;">
                        <th style="padding:4px 8px;font-size:10px;text-align:left;border-bottom:1px solid #dde;">E-Schooling</th>
                        <th style="padding:4px 8px;font-size:10px;text-align:left;border-bottom:1px solid #dde;">Perfil</th>
                        <th style="padding:4px 8px;font-size:10px;text-align:center;border-bottom:1px solid #dde;">Nota</th>
                        <th style="padding:4px 8px;font-size:10px;text-align:center;border-bottom:1px solid #dde;">Estado</th>
                    </tr>
                </thead>
                <tbody>${linhas}</tbody>
            </table>
        </div>
    </details>
    ${none > 0 ? `<p style="font-size:11px;color:#c62828;margin:6px 0 0;">
        ⚠️ ${none} aluno(s) sem correspondência — não serão preenchidos.</p>` : ''}
    ${fuzzy > 0 ? `<p style="font-size:11px;color:#e65100;margin:4px 0 0;">
        🟡 Verifica visualmente as linhas amarelas antes de aplicar.</p>` : ''}
    <!-- Botões de confirmação -->
    <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="cjd-btn-aplicar" data-id="${p.id}"
            style="background:#2E7D32;color:#fff;border:none;padding:7px 16px;
                   border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;">
            ✅ Aplicar por nome
        </button>
        <button class="cjd-btn-fechar-prev" data-id="${p.id}"
            style="background:none;border:1px solid #ccc;color:#777;padding:7px 10px;
                   border-radius:6px;cursor:pointer;font-size:12px;">
            Cancelar
        </button>
    </div>
</div>`;

                        box.style.display = 'block';

                        box.querySelector('.cjd-btn-aplicar').addEventListener('click', () => {
                            const { preenchidos, ignorados } = preencherPorMapeamento(col.inputs, mapeamento);
                            setStatus(
                                `✅ ${preenchidos} nota(s) aplicadas do perfil "${p.nome}"` +
                                (ignorados > 0 ? ` (${ignorados} ignoradas)` : '') +
                                (none > 0 ? ` · ❌ ${none} não encontrados` : ''),
                                none > 0 || ignorados > 0 ? '#E65100' : '#2E7D32'
                            );
                            box.style.display = 'none';
                            if (overlay.querySelector('#cjd-autosave').checked) dispararGuardar();
                            setTimeout(() => overlay.remove(), 2800);
                        });
                        box.querySelector('.cjd-btn-fechar-prev').addEventListener('click', () => {
                            box.style.display = 'none';
                        });

                    } else {
                        /* ── SEM NOMES: carregar na textarea por ordem ── */
                        overlay.querySelector('#cjd-notas').value = p.notas.map(n => n.nota).join('\n');
                        setStatus(`📁 "${p.nome}" carregado (${p.notas.length} notas). Verifica e clica em Importar.`, '#1565C0');
                        overlay.querySelector('#cjd-perfis-details').open = false;
                    }
                })
            );
        }

        /* ── GUARDAR PERFIL ────────────────────────────────── */
        overlay.querySelector('#cjd-perfil-guardar').addEventListener('click', () => {
            const input  = overlay.querySelector('#cjd-perfil-nome');
            const nome   = input.value.trim();
            if (!nome) {
                input.style.border = '2px solid #E53935';
                input.focus();
                setTimeout(() => input.style.border = '1px solid #ccc', 2500);
                return;
            }
            const linhas = overlay.querySelector('#cjd-notas').value
                .split('\n').filter(s => s.trim() !== '');
            if (linhas.length === 0) {
                setStatus('⚠️ Cola as notas antes de guardar.', '#E65100');
                return;
            }
            const col    = colAtual();
            const perfil = criarPerfil(nome, linhas, col.nomes);
            Perfis.adicionar(perfil);
            renderizarPerfis();
            input.value = '';
            overlay.querySelector('#cjd-perfis-details').open = true;
            setStatus(`💾 Perfil "${nome}" guardado com ${linhas.length} notas!`, '#2E7D32');
            refreshBtnMain();
        });

        /* ── IMPORTAR (paste flow — v5.1 unchanged) ─────────── */
        overlay.querySelector('#cjd-importar').onclick = () => {
            const col    = colAtual();
            const linhas = overlay.querySelector('#cjd-notas').value
                .split('\n').filter(s => s.trim() !== '');

            if (linhas.length === 0) {
                setStatus('⚠️ Nenhuma nota encontrada. Cola o conteúdo do Excel.', '#E65100');
                return;
            }

            const { preenchidos, ignorados } = preencherNotas(col.inputs, linhas);
            let aviso = '';
            if (ignorados > 0)               aviso += ` (⚠️ ${ignorados} valor(es) não reconhecido(s))`;
            if (linhas.length > col.inputs.length) aviso += ` (⚠️ extras ignorados)`;
            else if (linhas.length < col.inputs.length) aviso += ` (${col.inputs.length - linhas.length} campo(s) por preencher)`;

            setStatus(`✅ ${preenchidos} nota(s) preenchida(s)${aviso}`,
                ignorados > 0 ? '#E65100' : '#2E7D32');
            if (overlay.querySelector('#cjd-autosave').checked) dispararGuardar();
            if (!aviso) setTimeout(() => overlay.remove(), 2500);
        };

        overlay.querySelector('#cjd-limpar').onclick = () => {
            overlay.querySelector('#cjd-notas').value = ''; setStatus('');
        };
        overlay.querySelector('#cjd-x').onclick = () => overlay.remove();

        renderizarPerfis();
        setTimeout(() => overlay.querySelector('#cjd-notas').focus(), 80);
    }

    /* ══════════════════════════════════════════════════════════════
       8. OBSERVAÇÃO DE MUDANÇAS  (SPA / DNN UpdatePanel)
    ══════════════════════════════════════════════════════════════ */
    let debounce;
    new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            document.getElementById(BTN_ID)?.remove();
            injetarBotao();
        }, 800);
    }).observe(document.body, { childList: true, subtree: true });

    [1000, 2500, 4500].forEach(t => setTimeout(injetarBotao, t));

})();
