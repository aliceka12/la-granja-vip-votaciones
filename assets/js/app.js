/**
 * Motor de Monitoreo - La Granja VIP (Segunda Temporada)
 * Soporta actualización en tiempo real en Vercel, Laragon local y GitHub Pages.
 * Incluye protección contra rollback/caché y presentación dinámica de resultados.
 */

const state = {
    data: null,
    lastConfigId: '',
    prevVotes: {},
    prevTotals: {},
    viewMode: 'dual',
    refreshMs: 5000,
    timerId: null,
    charts: {},
    logs: [],
    connectionMode: 'Detectando...'
};

const fmtNum = (n) => new Intl.NumberFormat('es-MX').format(Number(n) || 0);
const fmtPct = (n) => Number(n || 0).toFixed(2) + '%';

document.addEventListener('DOMContentLoaded', () => {
    setupControls();
    fetchLiveVotes(true);
    startAutoRefresh();
});

function setupControls() {
    const intervalSelect = document.getElementById('refresh-interval');
    if (intervalSelect) {
        intervalSelect.addEventListener('change', (e) => {
            state.refreshMs = parseInt(e.target.value, 10);
            startAutoRefresh();
        });
    }

    const btnRefresh = document.getElementById('btn-refresh-now');
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            btnRefresh.disabled = true;
            fetchLiveVotes(false).finally(() => {
                setTimeout(() => { btnRefresh.disabled = false; }, 400);
            });
        });
    }
}

function startAutoRefresh() {
    if (state.timerId) clearInterval(state.timerId);
    if (state.refreshMs > 0) {
        state.timerId = setInterval(() => fetchLiveVotes(false), state.refreshMs);
    }
}

async function fetchLiveVotes(isInitial = false) {
    updateSyncIndicator(true);

    // 1. Probar endpoints dinámicos en tiempo real con prioridad según el entorno
    const endpointsToTry = [];
    const isVercel = window.location.hostname.includes('vercel.app');
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (isLocal) {
        endpointsToTry.push('php/live.php');
        endpointsToTry.push('https://la-granja-vip-votaciones.vercel.app/api/live');
    } else if (isVercel) {
        endpointsToTry.push('api/live');
        endpointsToTry.push('https://la-granja-vip-votaciones.vercel.app/api/live');
    } else {
        // En GitHub Pages o cualquier otro host externo, ir directo a la Serverless Function de Vercel
        endpointsToTry.push('https://la-granja-vip-votaciones.vercel.app/api/live');
    }

    for (const ep of endpointsToTry) {
        try {
            const controller = new AbortController();
            // Tiempo de espera generoso (6s) para cubrir arranques en frío de funciones serverless
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const resp = await fetch(`${ep}?_t=${Date.now()}`, { 
                signal: controller.signal, 
                cache: 'no-store' 
            });
            clearTimeout(timeoutId);

            if (resp.ok) {
                const contentType = resp.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const json = await resp.json();
                    if (json && json.ok && Array.isArray(json.polls) && json.polls.length > 0) {
                        const hasVotes = json.polls.some(p => (p.totalActiveVotes || 0) > 0);
                        if (!hasVotes) {
                            // TV Azteca restringió/pausó el endpoint público de resultados: no sobrescribir con ceros
                            state.resultsRestricted = true;
                            break;
                        }
                        state.resultsRestricted = Boolean(json.resultsRestricted);
                        state.connectionMode = isLocal
                            ? '🟢 Motor Local Activo (Laragon)' 
                            : (state.resultsRestricted 
                                ? '⚠️ Conteo en vivo (Corte oficial TV Azteca tras Viernes de Traición)' 
                                : '🟢 Servidor Cloud en Vivo');
                        processIncomingData(json, isInitial);
                        updateSyncIndicator(false);
                        return;
                    }
                }
            }
        } catch (_) {}
    }

    // 2. Snapshot estático (Respaldo de emergencia cuando la API falla o TV Azteca restringe /api/results)
    if (state.resultsRestricted && state.data && state.data.polls?.some(p => (p.totalActiveVotes || 0) > 0)) {
        // Mantener los últimos datos válidos en pantalla y actualizar solo el aviso de estado
        state.connectionMode = '⚠️ Conteo público pausado por TV Azteca (último corte válido)';
        const elGlobalDelta = document.getElementById('kpi-global-delta');
        if (elGlobalDelta) elGlobalDelta.textContent = state.connectionMode;
        const banner = document.getElementById('live-mode-banner');
        if (banner) {
            banner.innerHTML = '<span>⚠️ <strong>Aviso de TV Azteca:</strong> El servidor oficial (<code>vota.tvazteca.com/api/results</code>) restringió temporalmente la consulta pública de resultados. Mostrando el último corte válido registrado; el monitor reanudará automáticamente cuando TV Azteca reactive el conteo.</span>';
            banner.style.display = 'flex';
        }
        updateSyncIndicator(false);
        return;
    }

    try {
        const snapResp = await fetch(`data/snapshot.json?_t=${Date.now()}`, { cache: 'no-store' });
        if (snapResp.ok) {
            const snapshot = await snapResp.json();
            if (snapshot && snapshot.ok && Array.isArray(snapshot.polls) && snapshot.polls.length > 0) {
                const snapConfigId = snapshot.polls[0]?.configId || '';
                // Protección contra rollback: no degradar a un snapshot viejo si ya tenemos una votación activa más reciente
                if (state.lastConfigId && snapConfigId && state.lastConfigId !== snapConfigId && state.data?.status?.votingOpen) {
                    updateSyncIndicator(false);
                    return;
                }

                let timeText = '';
                if (snapshot.timestamp) {
                    const dateObj = new Date(snapshot.timestamp);
                    timeText = ` (${dateObj.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })})`;
                }
                state.connectionMode = state.resultsRestricted
                    ? `⚠️ Último corte oficial antes del bloqueo${timeText}`
                    : `☁️ Snapshot Sincronizado${timeText}`;
                processIncomingData(snapshot, isInitial);
                updateSyncIndicator(false);
                return;
            }
        }
    } catch (err) {
        console.warn('Error leyendo snapshot:', err);
    }
    updateSyncIndicator(false);
}

function processIncomingData(data, isInitial) {
    const isClosed = data.status && data.status.votingOpen === false;
    const currentConfigId = data.polls && data.polls[0] ? data.polls[0].configId : '';

    // Si cambió la placa o ID de votación (ej. de salvación a duelo de nominación)
    if (state.lastConfigId && currentConfigId && state.lastConfigId !== currentConfigId) {
        state.prevVotes = {};
        state.prevTotals = {};
        state.logs = [];
        Object.keys(state.charts).forEach(k => {
            if (state.charts[k]) {
                state.charts[k].destroy();
                delete state.charts[k];
            }
        });
    }
    state.lastConfigId = currentConfigId;
    state.data = data;

    const deltas = {};
    let totalGlobalVotes = 0;
    let totalGlobalDelta = 0;

    data.polls.forEach(poll => {
        totalGlobalVotes += poll.totalActiveVotes;
        const prevPollTotal = state.prevTotals[poll.configId];
        if (prevPollTotal !== undefined && poll.totalActiveVotes > prevPollTotal) {
            const diffPoll = poll.totalActiveVotes - prevPollTotal;
            totalGlobalDelta += diffPoll;
        }
        state.prevTotals[poll.configId] = poll.totalActiveVotes;

        poll.contestants.forEach(c => {
            const key = `${poll.configId}_${c.id}`;
            const prev = state.prevVotes[key];
            if (prev !== undefined && c.votes > prev) {
                const diff = c.votes - prev;
                deltas[key] = diff;
                if (!isClosed) {
                    addVoteLog(poll.title, c.name, diff, c.votes);
                }
            }
            state.prevVotes[key] = c.votes;
        });
    });

    renderHeaderAndKPIs(data, totalGlobalVotes, totalGlobalDelta, isClosed);
    renderTabs(data.polls);
    renderPolls(data.polls, deltas, isClosed);
    renderLogs(isClosed, data.polls[0]);
}

function addVoteLog(pollTitle, contestantName, diff, newTotal) {
    const now = new Date().toLocaleTimeString('es-MX', { hour12: false });
    state.logs.unshift({
        time: now,
        pollTitle,
        contestantName,
        diff,
        newTotal
    });
    if (state.logs.length > 25) state.logs.pop();
}

function renderHeaderAndKPIs(data, totalGlobalVotes, totalGlobalDelta, isClosed) {
    const banner = document.getElementById('live-mode-banner');
    const btnLocal = document.getElementById('btn-local-live');
    const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (state.resultsRestricted) {
        if (banner) {
            banner.innerHTML = '<span>⚠️ <strong>Aviso de TV Azteca:</strong> El servidor oficial (<code>vota.tvazteca.com/api/results</code>) restringió temporalmente la consulta pública de resultados. Mostrando el último corte válido registrado; el monitor reanudará automáticamente cuando TV Azteca reactive el conteo.</span>';
            banner.style.display = 'flex';
        }
        if (isLocalHost && btnLocal) btnLocal.style.display = 'none';
    } else if (isLocalHost) {
        if (banner) banner.style.display = 'none';
        if (btnLocal) btnLocal.style.display = 'none';
    } else {
        if (state.connectionMode.includes('Snapshot') && !isClosed) {
            if (banner) banner.style.display = 'flex';
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    const btnVote = document.getElementById('btn-vote-link');
    const lblTotal = document.getElementById('kpi-label-total');

    if (statusBadge && statusText) {
        if (!isClosed) {
            statusBadge.classList.remove('closed');
            statusText.textContent = 'VOTACIÓN ABIERTA EN VIVO';
            if (btnVote) {
                btnVote.innerHTML = '🗳️ Ir a Votar en TV Azteca';
                btnVote.style.opacity = '1';
                btnVote.style.pointerEvents = 'auto';
            }
            if (lblTotal) lblTotal.textContent = 'Total Votos Acumulados (Hoy)';
        } else {
            statusBadge.classList.add('closed');
            statusText.textContent = '🔴 VOTACIÓN CERRADA · RESULTADOS FINALES';
            if (btnVote) {
                btnVote.innerHTML = '🔒 Votación Concluida';
                btnVote.style.opacity = '0.75';
            }
            if (lblTotal) lblTotal.textContent = 'Total Votos Oficiales (Cierre Gala)';
        }
    }

    const elTotalGlobal = document.getElementById('kpi-global-votes');
    if (elTotalGlobal) elTotalGlobal.textContent = fmtNum(totalGlobalVotes);

    const elGlobalDelta = document.getElementById('kpi-global-delta');
    if (elGlobalDelta) {
        if (isClosed) {
            elGlobalDelta.textContent = '✅ Resultados Oficiales Definitivos';
        } else if (totalGlobalDelta > 0) {
            elGlobalDelta.innerHTML = `<span class="delta-pill">+${fmtNum(totalGlobalDelta)} votos nuevos</span>`;
        } else {
            elGlobalDelta.textContent = state.connectionMode;
        }
    }

    // Líder / 1° Lugar Votación 1
    if (data.polls[0] && data.polls[0].contestants[0]) {
        const p1 = data.polls[0];
        const leader1 = p1.contestants[0];
        const lbl1 = document.getElementById('kpi-leader1-label');
        if (lbl1) {
            lbl1.textContent = isClosed 
                ? '🏆 1° Lugar Oficial' 
                : `1° Lugar · ${p1.title.slice(0, 24)}`;
        }
        document.getElementById('kpi-leader1-name').textContent = leader1.name;
        document.getElementById('kpi-leader1-sub').textContent = isClosed
            ? `${fmtPct(leader1.percentage)} (${fmtNum(leader1.votes)} votos) · 1° Lugar`
            : `${fmtPct(leader1.percentage)} (${fmtNum(leader1.votes)} votos)`;
    }

    // Segundo lugar / En Riesgo / Último lugar
    const lbl2 = document.getElementById('kpi-leader2-label');
    if (data.polls[1] && data.polls[1].contestants[0]) {
        const p2 = data.polls[1];
        const leader2 = p2.contestants[0];
        if (lbl2) lbl2.textContent = `1° Lugar · ${p2.title.slice(0, 24)}`;
        document.getElementById('kpi-leader2-name').textContent = leader2.name;
        document.getElementById('kpi-leader2-sub').textContent = `${fmtPct(leader2.percentage)} (${fmtNum(leader2.votes)} votos)`;
    } else if (data.polls[0] && data.polls[0].contestants.length > 1) {
        const p1 = data.polls[0];
        const lastContestant = p1.contestants[p1.contestants.length - 1];
        if (lbl2) {
            lbl2.textContent = isClosed 
                ? 'Última Posición' 
                : 'En Riesgo / Última Posición';
        }
        document.getElementById('kpi-leader2-name').textContent = lastContestant.name;
        document.getElementById('kpi-leader2-sub').textContent = isClosed
            ? `${fmtPct(lastContestant.percentage)} (${fmtNum(lastContestant.votes)} votos)`
            : `${fmtPct(lastContestant.percentage)} (${fmtNum(lastContestant.votes)} votos)`;
    }

    const elLastSync = document.getElementById('kpi-last-sync');
    if (elLastSync) {
        const nowStr = new Date().toLocaleTimeString('es-MX', { hour12: false });
        elLastSync.textContent = nowStr;
    }
    const elMode = document.getElementById('kpi-sync-mode');
    if (elMode) {
        elMode.textContent = isClosed
            ? 'Votación Concluida'
            : `Versión config: ${data.status?.configVersion || 'v2'}`;
    }
}

function renderTabs(polls) {
    const container = document.getElementById('poll-tabs-container');
    if (!container) return;

    // Si solo hay una votación activa o ninguna, no mostrar barra de pestañas para evitar duplicar títulos
    if (!polls || polls.length <= 1) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    container.style.display = 'flex';
    const isClosed = state.data?.status?.votingOpen === false;
    const buttonsHtml = [];
    if (polls.length > 1) {
        buttonsHtml.push(`
            <button class="poll-tab-btn ${state.viewMode === 'dual' ? 'active' : ''}" onclick="setViewMode('dual')">
                <div class="tab-title-wrap">
                    <span class="tab-badge">${isClosed ? 'RESULTADOS FINALES' : 'VISTA COMPLETA'}</span>
                    <span class="tab-main-title">Todas las Votaciones (${polls.length})</span>
                </div>
                <span class="tab-votes-count">${polls.length} Paneles</span>
            </button>
        `);
    }

    polls.forEach((poll, idx) => {
        let label = poll.internalName
            ? poll.internalName.replace(/- LGVIP26.*/i, '').trim()
            : `VOTACIÓN #${idx + 1}`;
        if (isClosed) {
            label = '🏆 RESULTADO OFICIAL';
        }
        buttonsHtml.push(`
            <button class="poll-tab-btn ${state.viewMode === poll.key || (polls.length === 1 && idx === 0) ? 'active' : ''}" onclick="setViewMode('${poll.key}')">
                <div class="tab-title-wrap">
                    <span class="tab-badge">${escapeHtml(label)}</span>
                    <span class="tab-main-title">${escapeHtml(poll.title)}</span>
                </div>
                <span class="tab-votes-count">${fmtNum(poll.totalActiveVotes)}</span>
            </button>
        `);
    });

    container.innerHTML = buttonsHtml.join('');
}

window.setViewMode = function(mode) {
    state.viewMode = mode;
    if (state.data) {
        renderTabs(state.data.polls);
        renderPolls(state.data.polls, {}, state.data.status?.votingOpen === false);
    }
};

function renderPolls(polls, deltas, isClosed) {
    const wrapper = document.getElementById('polls-wrapper');
    if (!wrapper) return;

    const visiblePolls = state.viewMode === 'dual'
        ? polls
        : polls.filter(p => p.key === state.viewMode);

    wrapper.className = state.viewMode === 'dual' && visiblePolls.length > 1
        ? 'polls-Wrapper dual-view'
        : 'polls-Wrapper';

    wrapper.innerHTML = visiblePolls.map((poll, idx) => {
        const isEliminationOrSave = /salv|nominad|elimin|favorito/i.test(poll.title + ' ' + poll.internalName);
        const winner = poll.contestants[0];
        const loser = poll.contestants[poll.contestants.length - 1];
        const diffVotes = winner && loser && poll.contestants.length > 1 ? winner.votes - loser.votes : 0;

        let badgeLabel = poll.internalName
            ? poll.internalName
            : (idx === 0 ? 'VOTACIÓN PRINCIPAL' : 'VOTACIÓN SECUNDARIA');

        let displayTitle = poll.title;
        let displaySubtitle = poll.subtitle;

        if (isClosed) {
            badgeLabel = '🏆 RESULTADOS OFICIALES DEFINITIVOS';
            displayTitle = `Resultado Oficial: ${poll.title.replace(/^¡Vota (para|por) /i, '').replace(/!$/, '')}`;
            displaySubtitle = `Votación concluida al término del programa por Azteca UNO · Total: ${fmtNum(poll.totalActiveVotes)} votos auditados.`;
        }

        // Veredicto final destacado cuando la votación ya cerró
        let verdictCardHtml = '';
        if (isClosed && winner && loser && poll.contestants.length >= 2) {
            const winPill = isEliminationOrSave ? '🏆 SALVADA / SALVADO POR EL PÚBLICO' : '👑 1° LUGAR DE LA VOTACIÓN';
            const losePill = isEliminationOrSave ? '❌ PARTICIPANTE ELIMINADO' : 'MENOR VOTACIÓN REGISTRADA';

            verdictCardHtml = `
                <div class="final-verdict-card">
                    <div class="verdict-header">
                        <span class="verdict-closed-tag">
                            <span class="verdict-closed-dot"></span>
                            Veredicto Oficial · Votación Cerrada
                        </span>
                        <span class="verdict-notice">Votación cerrada al 100% · Cifras definitivas TV Azteca</span>
                    </div>
                    <div class="verdict-grid">
                        <div class="verdict-col winner">
                            <div class="verdict-avatar-wrap">
                                <img class="verdict-avatar" src="${escapeHtml(winner.image)}" alt="${escapeHtml(winner.name)}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(winner.name)}&background=10b981&color=fff'">
                                <span class="verdict-crown">👑</span>
                            </div>
                            <div class="verdict-details">
                                <span class="verdict-pill-win">${winPill}</span>
                                <h4>${escapeHtml(winner.name)}</h4>
                                <div class="verdict-stats">
                                    <strong>${fmtPct(winner.percentage)}</strong> (${fmtNum(winner.votes)} votos)<br>
                                    Mayor respaldo obtenido en esta votación
                                </div>
                            </div>
                        </div>

                        <div class="verdict-col loser">
                            <div class="verdict-avatar-wrap">
                                <img class="verdict-avatar" src="${escapeHtml(loser.image)}" alt="${escapeHtml(loser.name)}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(loser.name)}&background=ef4444&color=fff'">
                                <span class="verdict-skull">❌</span>
                            </div>
                            <div class="verdict-details">
                                <span class="verdict-pill-lose">${losePill}</span>
                                <h4>${escapeHtml(loser.name)}</h4>
                                <div class="verdict-stats">
                                    <strong>${fmtPct(loser.percentage)}</strong> (${fmtNum(loser.votes)} votos)<br>
                                    Diferencia con el 1° lugar: -${fmtNum(diffVotes)} votos
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        const cardsHtml = poll.contestants.map((c) => {
            const key = `${poll.configId}_${c.id}`;
            const delta = deltas[key] || 0;
            const deltaHtml = delta > 0 && !isClosed
                ? `<span class="delta-pill">+${fmtNum(delta)}</span>`
                : '';

            let statusTag = 'En competencia';
            let cardExtraClass = '';

            if (isClosed) {
                cardExtraClass = 'is-closed ';
                if (c.rank === 1) {
                    cardExtraClass += 'rank-1 ';
                    statusTag = '<span class="status-pill-saved">👑 1° LUGAR OFICIAL · Mayor votación</span>';
                } else if (c.rank === poll.contestants.length && poll.contestants.length > 1) {
                    cardExtraClass += 'rank-last ';
                    const diffLeader = poll.contestants[0].votes - c.votes;
                    statusTag = `<span class="status-pill-eliminated">Diferencia con el 1° lugar: -${fmtNum(diffLeader)} votos</span>`;
                } else {
                    const diffLeader = poll.contestants[0].votes - c.votes;
                    statusTag = `Posición #${c.rank} (-${fmtNum(diffLeader)} votos del 1° lugar)`;
                }
            } else {
                if (c.rank === 1) {
                    statusTag = '🔥 1° Lugar actual en la votación (Mayor apoyo)';
                } else if (c.rank === poll.contestants.length && poll.contestants.length > 2) {
                    statusTag = '⚠️ Menor porcentaje registrado';
                } else if (c.rank > 1) {
                    const diffLeader = poll.contestants[0].votes - c.votes;
                    statusTag = `A ${fmtNum(diffLeader)} votos del 1° lugar`;
                }
            }

            return `
                <div class="contestant-card rank-${c.rank} ${cardExtraClass}">
                    <div class="contestant-top">
                        <div class="contestant-identity">
                            <div class="rank-badge">${isClosed && c.rank === 1 ? '👑' : '#' + c.rank}</div>
                            <img class="contestant-avatar" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=da07c8&color=fff'">
                            <div>
                                <div class="contestant-name">${escapeHtml(c.name)}</div>
                                <div class="contestant-status-tag">${statusTag}</div>
                            </div>
                        </div>
                        <div class="contestant-metrics">
                            <div class="percentage-big">${fmtPct(c.percentage)}</div>
                            <div class="votes-exact">
                                ${deltaHtml}
                                <span>${fmtNum(c.votes)} votos</span>
                            </div>
                        </div>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill" style="width: ${Math.max(c.percentage, 1.2)}%"></div>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <section class="poll-section">
                <div class="poll-header">
                    <div>
                        <span class="poll-tag ${isClosed ? 'closed' : ''}">${escapeHtml(badgeLabel)}</span>
                        <h2>${escapeHtml(displayTitle)}</h2>
                        <p class="poll-subtitle">${escapeHtml(displaySubtitle)} · ID: <code>${poll.configId.slice(0, 8)}</code></p>
                    </div>
                    <div class="poll-total-box">
                        <span>${isClosed ? 'Votos Totales Auditados' : 'Votos Totales'}</span>
                        <strong>${fmtNum(poll.totalActiveVotes)}</strong>
                    </div>
                </div>

                ${verdictCardHtml}

                <div class="contestants-list">
                    ${cardsHtml}
                </div>
                <div class="chart-container-box">
                    <canvas id="chart-${poll.key}"></canvas>
                </div>
            </section>
        `;
    }).join('');

    if (window.Chart) {
        visiblePolls.forEach(poll => renderPollChart(poll));
    }
}

function renderPollChart(poll) {
    const canvasId = `chart-${poll.key}`;
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (state.charts[canvasId]) {
        state.charts[canvasId].destroy();
    }

    const isMobile = window.innerWidth <= 600;
    const labels = poll.contestants.map(c => {
        if (!isMobile) return c.name;
        // En celular: acortar nombres largos (e.g. "Kevyn" en vez de 'Kevyn "Bicolor"')
        const clean = c.name.replace(/"[^"]*"/g, '').trim();
        return clean.length > 9 ? clean.split(' ')[0] : clean;
    });
    const dataVotes = poll.contestants.map(c => c.votes);
    const colors = [
        '#10b981',
        '#f59e0b',
        '#06b6d4',
        '#8b5cf6',
        '#ec4899',
        '#ef4444',
        '#64748b'
    ];

    state.charts[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Votos Registrados',
                data: dataVotes,
                backgroundColor: colors.slice(0, labels.length),
                borderRadius: isMobile ? 5 : 8,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (tooltipItems) => {
                            const idx = tooltipItems[0].dataIndex;
                            return poll.contestants[idx]?.name || '';
                        },
                        label: (context) => {
                            const total = poll.totalActiveVotes || 1;
                            const pct = ((context.raw / total) * 100).toFixed(2);
                            return ` ${fmtNum(context.raw)} votos (${pct}%)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { 
                        color: '#cbd5e1', 
                        font: { weight: '600', size: isMobile ? 10 : 12 },
                        maxRotation: isMobile ? 35 : 0,
                        minRotation: isMobile ? 35 : 0
                    },
                    grid: { display: false }
                },
                y: {
                    ticks: {
                        color: '#94a3b8',
                        font: { size: isMobile ? 10 : 12 },
                        callback: (val) => {
                            if (val >= 1000000) {
                                const m = val / 1000000;
                                return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
                            }
                            if (val >= 1000) {
                                return (val / 1000).toFixed(0) + 'k';
                            }
                            return fmtNum(val);
                        }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.06)' }
                }
            }
        }
    });
}

function renderLogs(isClosed, poll) {
    const list = document.getElementById('live-log-list');
    if (!list) return;

    if (isClosed && poll && poll.contestants && poll.contestants.length > 0) {
        const winner = poll.contestants[0];
        const loser = poll.contestants[poll.contestants.length - 1];
        list.innerHTML = `
            <li class="log-item" style="border-left-color: #10b981;">
                <span><strong>${escapeHtml(winner.name)}</strong> obtuvo la mayor votación con el ${fmtPct(winner.percentage)} (${fmtNum(winner.votes)} votos)</span>
                <span style="color:#34d399">1° Lugar</span>
            </li>
            <li class="log-item" style="border-left-color: #ef4444;">
                <span><strong>${escapeHtml(loser.name)}</strong> concluyó con el ${fmtPct(loser.percentage)} (${fmtNum(loser.votes)} votos)</span>
                <span style="color:#f87171">Último</span>
            </li>
            <li class="log-item">
                <span>Votación cerrada al 100% de escrutinio con ${fmtNum(poll.totalActiveVotes)} votos totales</span>
                <span style="color:#94a3b8">Oficial</span>
            </li>
        `;
        return;
    }

    if (state.logs.length === 0) {
        list.innerHTML = `<li class="log-item"><span>Votación en vivo activa. Esperando nuevos registros de votos...</span><span>En vivo</span></li>`;
        return;
    }

    list.innerHTML = state.logs.map(item => `
        <li class="log-item">
            <span><strong>${escapeHtml(item.contestantName)}</strong> sumó <span class="delta-pill">+${fmtNum(item.diff)}</span> (${escapeHtml(item.pollTitle.slice(0, 24))}...)</span>
            <span style="color:#94a3b8">${item.time}</span>
        </li>
    `).join('');
}

function updateSyncIndicator(loading) {
    const btn = document.getElementById('btn-refresh-now');
    if (!btn) return;
    btn.style.opacity = loading ? '0.65' : '1';
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Re-renderizar gráficas dinámicamente cuando el usuario rota la pantalla o cambia el tamaño
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (state.data && state.data.polls && window.Chart) {
            const visiblePolls = state.viewMode === 'dual'
                ? state.data.polls
                : state.data.polls.filter(p => p.key === state.viewMode);
            visiblePolls.forEach(poll => renderPollChart(poll));
        }
    }, 250);
});
