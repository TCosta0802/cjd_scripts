// ==UserScript==
// @name         E-Schooling CJD — Importar Notas do Excel
// @namespace    https://eschooling.colegiojuliodinis.pt/
// @version      5.1
// @description  Importa notas do Excel (colar texto) em ecrãs de avaliação — numérica e qualitativa
// @author       CJD IT
// @match        https://eschooling.colegiojuliodinis.pt/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://URL_DO_TEAMS/cjd-importar-notas.user.js
// @downloadURL  https://URL_DO_TEAMS/cjd-importar-notas.user.js
// ==/UserScript==

(function () {
    'use strict';

    const BTN_ID   = 'cjd-import-btn';
    const MODAL_ID = 'cjd-import-modal';

    /* ═══════════════════════════════════════════════════════════
       1. NORMALIZAÇÃO DE NOTAS
       ═══════════════════════════════════════════════════════════
       Regras:
         - Qualitativas (F, I, S, B, MB) → passam intactas em maiúsculas
         - Números com vírgula ou ponto:
             · Para inputs de texto  → vírgula PT, sem ,0 desnecessário
               ex: 90,0 → "90"  |  97,5 → "97,5"  |  14,3 → "14,3"
             · Para selects          → arredonda para inteiro
               ex: 97,5 → "98"  |  14,3 → "14"  |  3,0 → "3"
    ═══════════════════════════════════════════════════════════ */

    const QUALITATIVAS = ['F', 'I', 'S', 'B', 'MB'];

    // Devolve o valor interno (sempre com ponto decimal se numérico)
    function normalizarNota(raw) {
        const v = raw.trim().replace(/\t/g, '');
        if (v === '') return null;
        if (QUALITATIVAS.includes(v.toUpperCase())) return v.toUpperCase();
        // Aceita vírgula ou ponto como separador decimal
        if (/^[\d]+([,.]\d+)?$/.test(v)) return v.replace(',', '.');
        return v; // texto livre desconhecido
    }

    // Para inputs de texto: arredonda sempre para inteiro (e-schooling não aceita decimais)
    function notaParaInput(interno) {
        const n = parseFloat(interno);
        if (isNaN(n)) return interno;                    // qualitativa ou texto
        return String(Math.round(n));                    // 97.5 → "98"  |  90.0 → "90"
    }

    // Para selects: arredonda para inteiro (97.5 → "98", 3.0 → "3")
    function notaParaSelect(interno) {
        const n = parseFloat(interno);
        if (isNaN(n)) return interno;                    // qualitativa ou texto
        return String(Math.round(n));
    }

    /* ═══════════════════════════════════════════════════════════
       2. DETECÇÃO DOS CAMPOS DE NOTA NA PÁGINA
          Suporta: input[type=text]  e  <select> (dropdowns)
          Devolve: [{ coluna, inputs: [elem, …], tipo }]
    ═══════════════════════════════════════════════════════════ */
    function encontrarColunasDeNota() {
        const resultados = [];

        document.querySelectorAll('table').forEach(tabela => {
            const linhaHeader = tabela.querySelector('tr:first-child');
            if (!linhaHeader) return;

            const celulasHeader = [...linhaHeader.querySelectorAll('th, td')];

            celulasHeader.forEach((th, colIdx) => {
                if (!/nota/i.test(th.textContent.trim())) return;

                const linhas = [...tabela.querySelectorAll('tr')].slice(1);
                const campos = linhas
                    .map(tr => {
                        const cels = [...tr.querySelectorAll('td')];
                        const cel  = cels[colIdx];
                        if (!cel) return null;
                        return cel.querySelector(
                            'input[type="text"], input:not([type]), select'
                        );
                    })
                    .filter(Boolean)
                    .filter(el => el.offsetParent !== null);

                if (campos.length > 0) {
                    resultados.push({
                        coluna: th.textContent.trim() || `Coluna ${colIdx + 1}`,
                        inputs: campos,
                        tipo:   detectarTipo(campos)
                    });
                }
            });
        });

        // Fallback: sem cabeçalho "nota", usa todos os inputs/selects visíveis em tabelas
        if (resultados.length === 0) {
            const fallback = [
                ...document.querySelectorAll(
                    'table input[type="text"], table input:not([type]), table select'
                )
            ].filter(el => el.offsetParent !== null);

            if (fallback.length > 0) {
                resultados.push({
                    coluna: 'Nota (detetado automaticamente)',
                    inputs: fallback,
                    tipo:   detectarTipo(fallback)
                });
            }
        }

        return resultados;
    }

    /* Determina o tipo de coluna com base no primeiro campo */
    function detectarTipo(campos) {
        const primeiro = campos[0];
        if (!primeiro) return 'texto';

        if (primeiro.tagName === 'SELECT') {
            const opcoes = [...primeiro.options]
                .map(o => o.text.trim())
                .filter(t => t && !/escolher/i.test(t));

            // Qualitativa: todas as opções são letras conhecidas
            if (opcoes.every(o => QUALITATIVAS.includes(o.toUpperCase()))) {
                return 'qualitativa';
            }

            // Numérica em lista: determina o intervalo
            const nums = opcoes.map(Number).filter(n => !isNaN(n));
            if (nums.length > 0) {
                return `select-${Math.min(...nums)}-${Math.max(...nums)}`; // ex: "select-1-20"
            }

            return 'select';
        }

        return 'texto'; // input normal
    }

    /* Devolve a descrição legível do tipo para mostrar no modal */
    function descricaoTipo(tipo) {
        if (tipo === 'qualitativa') return '🔤 Qualitativa  (F / I / S / B / MB)';
        if (tipo === 'texto')       return '✏️ Numérica  (só inteiros — decimais são arredondados: 97,5 → 98)';
        if (tipo.startsWith('select-')) {
            const [, min, max] = tipo.split('-');
            return `🔢 Lista  ${min} a ${max}  — decimais são arredondados automaticamente`;
        }
        return tipo;
    }

    /* ═══════════════════════════════════════════════════════════
       3. PREENCHIMENTO DOS CAMPOS
    ═══════════════════════════════════════════════════════════ */
    function preencherNotas(campos, linhasBrutas) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        let preenchidos = 0, ignorados = 0;

        const notas = linhasBrutas
            .map(normalizarNota)
            .filter(v => v !== null);

        notas.forEach((nota, i) => {
            const campo = campos[i];
            if (!campo) return;

            if (campo.tagName === 'SELECT') {
                const procurar = notaParaSelect(nota);
                const opcao = [...campo.options].find(
                    o =>
                        o.text.trim().toUpperCase()  === procurar.toUpperCase() ||
                        o.value.trim().toUpperCase() === procurar.toUpperCase()
                );
                if (opcao) {
                    campo.value = opcao.value;
                    ['change', 'blur'].forEach(evt =>
                        campo.dispatchEvent(new Event(evt, { bubbles: true }))
                    );
                    preenchidos++;
                } else {
                    ignorados++;
                    console.warn(`[CJD] Opção "${procurar}" não encontrada no select (linha ${i + 1})`);
                }
            } else {
                // Input de texto
                const valorFinal = notaParaInput(nota);
                setter.call(campo, valorFinal);
                ['input', 'change', 'blur'].forEach(evt =>
                    campo.dispatchEvent(new Event(evt, { bubbles: true }))
                );
                preenchidos++;
            }
        });

        return { preenchidos, ignorados };
    }

    /* ═══════════════════════════════════════════════════════════
       4. BOTÃO FLUTUANTE
    ═══════════════════════════════════════════════════════════ */
    function injetarBotao() {
        if (document.getElementById(BTN_ID)) return;

        const colunas = encontrarColunasDeNota();
        if (colunas.length === 0) return;

        const total = colunas.reduce((s, c) => s + c.inputs.length, 0);

        const btn = document.createElement('button');
        btn.id          = BTN_ID;
        btn.type        = 'button';
        btn.innerHTML   = '📋 Importar Notas';
        btn.title       = `${total} campo(s) de nota detetados`;
        btn.style.cssText = [
            'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9998',
            'background:#1565C0', 'color:#fff',
            'border:none', 'border-radius:8px',
            'padding:10px 18px', 'font-size:14px', 'font-weight:700',
            'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
            'transition:background .15s',
        ].join(';');

        btn.addEventListener('mouseenter', () => btn.style.background = '#0D47A1');
        btn.addEventListener('mouseleave', () => btn.style.background = '#1565C0');
        btn.addEventListener('click',      () => abrirModal(colunas));

        document.body.appendChild(btn);
    }

    /* ═══════════════════════════════════════════════════════════
       5. MODAL
    ═══════════════════════════════════════════════════════════ */
    function abrirModal(colunas) {
        if (document.getElementById(MODAL_ID)) return;

        const selectorHTML = colunas.length > 1
            ? `<label style="font-size:12px;color:#555;display:block;margin-bottom:4px;">Coluna a preencher:</label>
               <select id="cjd-col-select"
                 style="width:100%;padding:6px;border:1px solid #ccc;border-radius:5px;
                        font-size:13px;margin-bottom:6px;">
                 ${colunas.map((c, i) =>
                     `<option value="${i}">${c.coluna} — ${c.inputs.length} aluno(s)</option>`
                 ).join('')}
               </select>`
            : `<p style="font-size:12px;color:#555;margin:0 0 4px;">
                 <strong>${colunas[0].coluna}</strong> — ${colunas[0].inputs.length} aluno(s)
               </p>`;

        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'background:rgba(0,0,0,.6)',
            'z-index:99999', 'display:flex',
            'align-items:center', 'justify-content:center',
        ].join(';');

        overlay.innerHTML = `
<div style="background:#fff;border-radius:12px;width:480px;
            box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:sans-serif;overflow:hidden;">

    <!-- Cabeçalho -->
    <div style="background:#1565C0;color:#fff;padding:14px 18px;
                display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:15px;">📋 Importar Notas do Excel</h3>
        <button id="cjd-x" style="background:none;border:none;color:#fff;
                font-size:22px;cursor:pointer;line-height:1;opacity:.8;">✕</button>
    </div>

    <!-- Corpo -->
    <div style="padding:18px;">

        ${selectorHTML}

        <!-- Badge de tipo (atualiza ao mudar coluna) -->
        <div id="cjd-tipo-badge"
             style="font-size:11px;color:#1565C0;background:#E3F2FD;
                    border-radius:6px;padding:5px 10px;margin-bottom:12px;"></div>

        <label style="font-size:12px;color:#555;display:block;margin-bottom:5px;">
            Copia a coluna de notas no Excel <strong>(Ctrl+C)</strong> e cola aqui <strong>(Ctrl+V)</strong>:
        </label>
        <textarea id="cjd-notas" rows="13"
            style="width:100%;box-sizing:border-box;font-family:monospace;font-size:13px;
                   border:1px solid #ccc;border-radius:6px;padding:8px;resize:vertical;"
            placeholder="Exemplos:&#10;90&#10;97,5&#10;14,3&#10;MB&#10;S&#10;3&#10;18"></textarea>
        <p style="font-size:11px;color:#aaa;margin:4px 0 14px;">
            Uma nota por linha · A ordem tem de corresponder à lista de alunos do E-Schooling
        </p>

        <!-- Botões de ação -->
        <div style="display:flex;gap:8px;margin-bottom:12px;">
            <button id="cjd-importar"
                style="flex:1;background:#2E7D32;color:#fff;border:none;padding:11px;
                       border-radius:7px;cursor:pointer;font-size:14px;font-weight:700;">
                ✅ Importar
            </button>
            <button id="cjd-limpar"
                style="background:#E64A19;color:#fff;border:none;padding:11px 14px;
                       border-radius:7px;cursor:pointer;font-size:18px;" title="Limpar">
                🗑
            </button>
        </div>

        <!-- Auto-guardar -->
        <label style="display:flex;align-items:center;gap:8px;
                      font-size:13px;color:#444;cursor:pointer;margin-bottom:6px;">
            <input type="checkbox" id="cjd-autosave" style="width:14px;height:14px;">
            Clicar automaticamente em "Guardar" após importar
        </label>

        <!-- Mensagem de estado -->
        <div id="cjd-status"
             style="font-size:13px;min-height:18px;font-weight:600;"></div>
    </div>
</div>`;

        document.body.appendChild(overlay);

        const setStatus = (msg, cor = '#333') => {
            const el = overlay.querySelector('#cjd-status');
            el.textContent = msg;
            el.style.color = cor;
        };

        const atualizarBadge = () => {
            const idx   = parseInt(overlay.querySelector('#cjd-col-select')?.value ?? '0');
            const badge = overlay.querySelector('#cjd-tipo-badge');
            if (badge) badge.textContent = descricaoTipo(colunas[idx].tipo);
        };

        overlay.querySelector('#cjd-col-select')?.addEventListener('change', atualizarBadge);
        atualizarBadge();

        overlay.querySelector('#cjd-limpar').onclick = () => {
            overlay.querySelector('#cjd-notas').value = '';
            setStatus('');
        };

        overlay.querySelector('#cjd-x').onclick = () => overlay.remove();

        overlay.querySelector('#cjd-importar').onclick = () => {
            const colIdx  = parseInt(overlay.querySelector('#cjd-col-select')?.value ?? '0');
            const campos  = colunas[colIdx].inputs;
            const texto   = overlay.querySelector('#cjd-notas').value;
            const linhas  = texto.split('\n').filter(s => s.trim() !== '');

            if (linhas.length === 0) {
                setStatus('⚠️ Nenhuma nota encontrada. Cola o conteúdo do Excel.', '#E65100');
                return;
            }

            const { preenchidos, ignorados } = preencherNotas(campos, linhas);

            let aviso = '';
            if (ignorados > 0) {
                aviso += ` (⚠️ ${ignorados} valor(es) não reconhecido(s) na lista)`;
            }
            if (linhas.length > campos.length) {
                aviso += ` (⚠️ só havia ${campos.length} campos — extras ignorados)`;
            } else if (linhas.length < campos.length) {
                aviso += ` (${campos.length - linhas.length} campo(s) ficaram por preencher)`;
            }

            setStatus(
                `✅ ${preenchidos} nota(s) preenchida(s)${aviso}`,
                ignorados > 0 ? '#E65100' : '#2E7D32'
            );

            if (overlay.querySelector('#cjd-autosave').checked) {
                const saveBtn = [...document.querySelectorAll(
                    'input[type="image"], input[type="submit"], button'
                )].filter(b =>
                    /guardar|salvar|save/i.test(
                        [b.value, b.textContent, b.title, b.alt].join(' ')
                    )
                );
                if (saveBtn.length > 0) {
                    setTimeout(() => {
                        saveBtn.forEach(b => b.click());
                        setStatus(
                            `✅ ${preenchidos} nota(s) importadas e "Guardar" clicado.`,
                            '#1565C0'
                        );
                    }, 400);
                } else {
                    setStatus(
                        `✅ ${preenchidos} nota(s) preenchida(s) — botão "Guardar" não encontrado.`,
                        '#2E7D32'
                    );
                }
            }

            if (!aviso) setTimeout(() => overlay.remove(), 2500);
        };

        setTimeout(() => overlay.querySelector('#cjd-notas').focus(), 80);
    }

    /* ═══════════════════════════════════════════════════════════
       6. OBSERVAÇÃO DE MUDANÇAS (SPA / DNN UpdatePanel AJAX)
    ═══════════════════════════════════════════════════════════ */
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
