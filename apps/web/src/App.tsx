import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Phaser from 'phaser';
import {
  Axe,
  TreePine,
  Mountain,
  Hammer,
  House,
  Warehouse,
  Castle,
  Compass,
  Crosshair,
  HelpCircle,
  X,
  ArrowRight,
  Users,
  LogOut,
  ShieldCheck,
  WifiOff,
  Pickaxe,
  ChevronRight,
  Map,
  Leaf,
} from 'lucide-react';
import { RECIPES, terrain, WORLD_SIZE, distance, type BuildingKind } from '@logs/shared';
import { WorldScene } from './game/WorldScene';
import { useWorld } from './state';
import { API, connect, gather, logout } from './network';

const icons = { house: House, lumber: Axe, storage: Warehouse, tower: Castle };
function GameCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: ref.current!,
      backgroundColor: '#142f31',
      antialias: true,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      scene: WorldScene,
      render: { roundPixels: false },
      audio: { noAudio: true },
    });
    return () => game.destroy(true);
  }, []);
  return (
    <div
      className="world-canvas"
      ref={ref}
      aria-label="Mundo isométrico. Clique no chão para andar e nos recursos para selecionar."
    />
  );
}
function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? 'large' : ''}`}>
      <div className="brand-seal">
        <TreePine size={large ? 38 : 27} />
        <Axe size={large ? 25 : 17} />
      </div>
      <div>
        <span className="eyebrow">UM PEQUENO COMEÇO. UM GRANDE REINO.</span>
        <h1>
          Lord of the <em>Logs</em>
          <span className="brand-dot">.</span>
        </h1>
      </div>
    </div>
  );
}
function Entry() {
  const [name, setName] = useState('');
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('logs:last-character') || 'null') as {
        name: string;
        token: string;
      } | null;
    } catch {
      return null;
    }
  });
  const [resumeError, setResumeError] = useState('');
  const resume = async () => {
    if (!saved) return;
    try {
      const response = await fetch(`${API}/api/me`, {
        headers: { Authorization: `Bearer ${saved.token}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new Error('A sessão anterior expirou. Crie um novo personagem.');
      sessionStorage.setItem('logs:token', saved.token);
      connect(saved.token);
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : 'Não foi possível retornar.');
    }
  };
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error('offline');
      return r.json() as Promise<{ status: string }>;
    },
    retry: false,
    refetchInterval: 10000,
  });
  const entry = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const data = (await response.json()) as { message: string };
        throw new Error(data.message || 'Não foi possível entrar.');
      }
      return response.json() as Promise<{ token: string }>;
    },
    onSuccess: ({ token }) => {
      sessionStorage.setItem('logs:token', token);
      localStorage.setItem('logs:last-character', JSON.stringify({ name, token }));
      connect(token);
    },
  });
  const error = entry.error instanceof Error ? entry.error.message : '';
  return (
    <div className="entry-wrap">
      <div className="entry-shade" />
      <section className="entry-card">
        <div className="entry-topline">
          <span className="tiny-tag">
            <Leaf size={13} /> UM MUNDO PARA CHAMAR DE SEU
          </span>
          <span className="version">ALPHA · 01</span>
        </div>
        <Brand large />
        <div className="ornament">
          <span />
          <TreePine size={16} />
          <span />
        </div>
        <h2>
          Todo reino começa
          <br />
          com <em>um tronco.</em>
        </h2>
        <p className="entry-description">
          Entre no Vale do Carvalho. Explore a floresta, junte seus primeiros recursos e construa
          algo que fica — mesmo quando você partir.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            entry.mutate();
          }}
        >
          <label htmlFor="nickname">COMO DEVEMOS CHAMAR VOCÊ?</label>
          <input
            id="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Seu nome no vale"
            minLength={2}
            maxLength={20}
            required
            autoComplete="nickname"
          />
          <button
            className="primary enter-button"
            disabled={entry.isPending || !health.isSuccess}
            type="submit"
          >
            {entry.isPending ? 'Preparando sua chegada…' : 'Começar minha história'}
            <ArrowRight size={18} />
          </button>
        </form>
        {saved && (
          <button
            className="text-button"
            onClick={() => void resume()}
            disabled={!health.isSuccess}
          >
            Continuar como {saved.name}
            <ArrowRight size={14} />
          </button>
        )}
        {(error || resumeError) && (
          <p className="error small" role="alert">
            {error || resumeError}
          </p>
        )}
        <div className="server-status">
          <i className={health.isSuccess ? 'live-dot' : 'offline-dot'} />
          {health.isSuccess
            ? 'Vale online'
            : health.isPending
              ? 'Consultando o vale…'
              : 'Servidor indisponível. Inicie o backend para entrar.'}
          <span>Sem cadastro. Só aventura.</span>
        </div>
        <div className="entry-features">
          <div>
            <Users size={19} />
            <span>
              Companhia real<small>Multiplayer ao vivo</small>
            </span>
          </div>
          <div>
            <ShieldCheck size={19} />
            <span>
              Seu legado fica<small>Mundo persistente</small>
            </span>
          </div>
        </div>
      </section>
      <div className="entry-caption">
        <span className="eyebrow">UM CANTINHO DE UM MUNDO VIVO</span>
        <h3>Vale do Carvalho</h3>
        <p>Florestas generosas. Ambições maiores ainda.</p>
        <div className="caption-line" />
      </div>
      <div className="entry-footer">
        FEITO DE MADEIRA, PEDRA E BOAS HISTÓRIAS.<span>Arte original · Mundo compartilhado</span>
      </div>
    </div>
  );
}
function Minimap() {
  const snapshot = useWorld((s) => s.snapshot);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const colors = {
      grass: '#7f9453',
      forest: '#426345',
      dirt: '#c1a36b',
      water: '#285761',
      stone: '#889080',
    };
    ctx.clearRect(0, 0, 152, 152);
    for (let x = 0; x < WORLD_SIZE; x++)
      for (let y = 0; y < WORLD_SIZE; y++) {
        ctx.fillStyle = colors[terrain(x, y)];
        ctx.fillRect(x * 4, y * 4, 4, 4);
      }
    for (const b of snapshot?.buildings ?? []) {
      ctx.fillStyle = '#e7b271';
      ctx.fillRect(b.x * 4, b.y * 4, 6, 6);
    }
    for (const p of snapshot?.players ?? []) {
      ctx.fillStyle = p.id === snapshot?.selfId ? '#fff4c2' : '#79e6e6';
      ctx.beginPath();
      ctx.arc(p.x * 4 + 2, p.y * 4 + 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [snapshot]);
  const self = snapshot?.players.find((p) => p.id === snapshot.selfId);
  return (
    <aside className="minimap panel">
      <div className="minimap-title">
        <Compass size={15} />
        <span>VALE DO CARVALHO</span>
      </div>
      <div className="map-frame">
        <canvas ref={ref} width={152} height={152} />
        <span className="north">N</span>
      </div>
      <div className="map-coordinate">
        <span>Floresta temperada</span>
        <b>
          {self?.x ?? 18}, {self?.y ?? 18}
        </b>
      </div>
    </aside>
  );
}
function Construction() {
  const { snapshot, buildKind, set } = useWorld();
  return (
    <section className="construction panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">DO PRIMEIRO TRONCO AO LAR</span>
          <h2>Construir no vale</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Fechar construções"
          onClick={() => set({ menu: false, buildKind: null })}
        >
          <X size={18} />
        </button>
      </div>
      <p className="muted small">Escolha uma estrutura e marque um terreno livre.</p>
      <div className="building-list">
        {(Object.entries(RECIPES) as [BuildingKind, (typeof RECIPES)[BuildingKind]][]).map(
          ([kind, recipe]) => {
            const Icon = icons[kind];
            const affordable =
              (snapshot?.inventory.wood ?? 0) >= recipe.wood &&
              (snapshot?.inventory.stone ?? 0) >= recipe.stone;
            return (
              <button
                key={kind}
                className={`building-card ${buildKind === kind ? 'selected' : ''}`}
                onClick={() => set({ buildKind: buildKind === kind ? null : kind, selected: null })}
              >
                <span className="building-icon">
                  <Icon size={28} />
                </span>
                <span className="building-copy">
                  <strong>{recipe.name}</strong>
                  <small>
                    {recipe.size} × {recipe.size} ·{' '}
                    {kind === 'house'
                      ? 'Seu primeiro lar'
                      : kind === 'lumber'
                        ? 'Trabalho e madeira'
                        : kind === 'storage'
                          ? 'Tudo em seu lugar'
                          : 'Olhos no horizonte'}
                  </small>
                  <span className={`cost ${affordable ? '' : 'missing'}`}>
                    <TreePine size={12} />
                    {recipe.wood}
                    <Mountain size={12} />
                    {recipe.stone}
                  </span>
                </span>
                <ChevronRight size={16} />
              </button>
            );
          },
        )}
      </div>
      <div className="tip">
        <ShieldCheck size={15} />
        <span>
          Construções ficam salvas no mundo. Custos são cobrados apenas após a confirmação.
        </span>
      </div>
    </section>
  );
}
function Selection() {
  const { snapshot, selected, set, connected } = useWorld();
  const node = snapshot?.nodes.find((n) => n.id === selected),
    building = snapshot?.buildings.find((b) => b.id === selected),
    self = snapshot?.players.find((p) => p.id === snapshot.selfId);
  if (!node && !building) return null;
  const inRange = node && self && distance(self, node) <= 1;
  return (
    <section className="selection panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{node ? 'RECURSO NATURAL' : 'CONSTRUÇÃO PERMANENTE'}</span>
          <h2>
            {node
              ? node.kind === 'wood'
                ? 'Carvalho do vale'
                : 'Depósito de pedra'
              : RECIPES[building!.kind].name}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Fechar seleção"
          onClick={() => set({ selected: null })}
        >
          <X size={17} />
        </button>
      </div>
      {node ? (
        <>
          <p className="muted small">
            {node.kind === 'wood'
              ? 'Um pequeno corte. Um grande começo.'
              : 'O alicerce de qualquer boa ideia.'}
          </p>
          <div className="resource-amount">
            <span>Disponível</span>
            <strong>
              {node.quantity} / {node.capacity}
            </strong>
          </div>
          <div className="progress-track">
            <i style={{ width: `${(node.quantity / node.capacity) * 100}%` }} />
          </div>
          <button
            className="primary"
            disabled={!connected || !inRange || node.quantity <= 0 || !!self?.gathering}
            onClick={() => gather(node.id)}
          >
            <Pickaxe size={16} />
            {self?.gathering
              ? 'Coletando…'
              : !inRange
                ? 'Aproxime-se para coletar'
                : node.quantity <= 0
                  ? 'Regenerando…'
                  : 'Coletar recurso'}
            <kbd>E</kbd>
          </button>
          <small className="muted">
            {node.quantity <= 0
              ? 'A floresta se renova em até 45 segundos.'
              : '1,5 segundo · até 4 unidades por coleta'}
          </small>
        </>
      ) : (
        <>
          <p className="muted small">{RECIPES[building!.kind].description}</p>
          <div className="resource-amount">
            <span>Integridade</span>
            <strong>{building!.durability}%</strong>
          </div>
          <p className="small gold">
            {building!.ownerId === snapshot?.selfId
              ? 'Construída por você'
              : 'Construída por outro viajante'}
          </p>
        </>
      )}
    </section>
  );
}
function Help() {
  const set = useWorld((s) => s.set);
  return (
    <div className="modal-backdrop">
      <section className="help panel">
        <div className="panel-heading">
          <h2>Seu primeiro dia no vale</h2>
          <button
            className="icon-button"
            aria-label="Fechar ajuda"
            onClick={() => set({ help: false })}
          >
            <X />
          </button>
        </div>
        <ol>
          <li>
            <strong>Explore.</strong> Clique no chão para andar. Selecione uma árvore ou pedra para
            se aproximar.
          </li>
          <li>
            <strong>Colete.</strong> Use o botão de coleta ou <kbd>E</kbd> quando estiver ao lado do
            recurso.
          </li>
          <li>
            <strong>Construa.</strong> Abra <kbd>B</kbd>, escolha uma estrutura e clique em terreno
            livre a até 6 passos.
          </li>
        </ol>
        <p>
          Arraste com o botão direito ou use as setas para mover a câmera. Use a roda do mouse para
          zoom e <kbd>F</kbd> para voltar ao personagem. <kbd>Esc</kbd> cancela a construção.
        </p>
        <div className="tip">
          Inventário e construções ficam no servidor. Ao reabrir o navegador, use “Continuar” para
          recuperar seu último personagem. Para jogar com outro viajante em uma segunda aba, escolha
          um novo nome.
        </div>
      </section>
    </div>
  );
}
export default function App() {
  const state = useWorld();
  const booted = useRef(false);
  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      const token = sessionStorage.getItem('logs:token');
      if (token) connect(token);
    }
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea')) return;
      const s = useWorld.getState();
      if (event.key.toLowerCase() === 'b') s.set({ menu: !s.menu, buildKind: null });
      if (event.key.toLowerCase() === 'f') s.set({ focus: s.focus + 1 });
      if (event.key === 'Escape')
        s.set({ menu: false, buildKind: null, selected: null, help: false });
      if (event.key.toLowerCase() === 'e' && s.selected && s.connected) gather(s.selected);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const self = state.snapshot?.players.find((p) => p.id === state.snapshot?.selfId);
  const owns = state.snapshot?.buildings.filter((b) => b.ownerId === self?.id).length ?? 0;
  return (
    <main>
      <GameCanvas />
      {!state.entered ? (
        <Entry />
      ) : (
        <div className="hud">
          <header className="topbar panel">
            <Brand />
            <div className="server-badge">
              <i className={state.connected ? 'live-dot' : 'offline-dot'} />
              <span>{state.connected ? 'Mundo ao vivo' : 'Reconectando…'}</span>
              <span className="online-count">
                <Users size={13} />
                {state.snapshot?.players.length ?? 0}
              </span>
            </div>
            <div className="resources">
              <div>
                <span className="resource-icon wood">
                  <TreePine size={21} />
                </span>
                <span>
                  <small>MADEIRA</small>
                  <strong>{state.snapshot?.inventory.wood ?? 0}</strong>
                </span>
              </div>
              <div>
                <span className="resource-icon stone">
                  <Mountain size={21} />
                </span>
                <span>
                  <small>PEDRA</small>
                  <strong>{state.snapshot?.inventory.stone ?? 0}</strong>
                </span>
              </div>
            </div>
            <button
              className="icon-button"
              aria-label="Ajuda"
              onClick={() => state.set({ help: true })}
            >
              <HelpCircle size={20} />
            </button>
            <button className="icon-button" aria-label="Sair do vale" onClick={logout}>
              <LogOut size={18} />
            </button>
          </header>
          <section className="character panel">
            <div className="portrait">
              <Axe size={24} />
            </div>
            <div>
              <span className="eyebrow">FUNDADOR EM FORMAÇÃO</span>
              <strong>{self?.name}</strong>
              <span className="character-sub">
                <i className="live-dot" />{' '}
                {self?.gathering ? 'Coletando recursos' : 'Um novo dia no vale'}
              </span>
            </div>
          </section>
          <Minimap />
          {!state.menu && !state.selected && (
            <section className="onboarding panel">
              <span className="eyebrow">SEU PEQUENO GRANDE REINO</span>
              <h2>{owns ? 'Raízes no vale' : 'O primeiro telhado'}</h2>
              <p>
                {owns
                  ? 'Seu legado já faz parte deste mundo. Continue construindo.'
                  : 'Nada de coroas por enquanto. Vamos começar com uma casa.'}
              </p>
              <div
                className={
                  state.snapshot && state.snapshot.inventory.wood >= 12 ? 'task done' : 'task'
                }
              >
                <TreePine size={15} />
                <span>Junte madeira</span>
                <b>{Math.min(state.snapshot?.inventory.wood ?? 0, 12)}/12</b>
              </div>
              <div
                className={
                  state.snapshot && state.snapshot.inventory.stone >= 4 ? 'task done' : 'task'
                }
              >
                <Mountain size={15} />
                <span>Junte pedra</span>
                <b>{Math.min(state.snapshot?.inventory.stone ?? 0, 4)}/4</b>
              </div>
              <div className={`task ${owns ? 'done' : ''}`}>
                <House size={15} />
                <span>Erga sua primeira construção</span>
                <b>{owns ? '✓' : '0/1'}</b>
              </div>
              <button className="text-button" onClick={() => state.set({ menu: true })}>
                Abrir construções <ArrowRight size={14} />
              </button>
            </section>
          )}
          {state.menu && <Construction />}
          {!state.menu && <Selection />}
          <div className="activity" aria-live="polite">
            {state.notices.slice(-3).map((n) => (
              <div key={n.id} className={n.error ? 'notice error' : 'notice'}>
                <i />
                {n.text}
              </div>
            ))}
          </div>
          {!state.connected && (
            <div className="connection-alert">
              <WifiOff size={18} /> Conexão perdida. As ações serão liberadas após a sincronização.
            </div>
          )}
          {state.buildKind && (
            <div className="placement-hint">
              <Hammer size={17} />
              {RECIPES[state.buildKind].name}
              <span>Clique no terreno para construir</span>
              <kbd>Esc</kbd>
            </div>
          )}
          <footer className="bottom-hud">
            <div className="location">
              <Map size={15} />
              <span>
                Vale do Carvalho
                <small>
                  {state.hover ? `${state.hover.x}, ${state.hover.y}` : 'Terras livres'}
                </small>
              </span>
            </div>
            <nav className="actionbar panel" aria-label="Ações do mundo">
              <button
                className={!state.menu ? 'active' : ''}
                onClick={() => state.set({ menu: false, buildKind: null })}
              >
                <Compass size={23} />
                <span>Explorar</span>
              </button>
              <button
                className={state.menu ? 'active' : ''}
                onClick={() => state.set({ menu: !state.menu, buildKind: null, selected: null })}
              >
                <Hammer size={23} />
                <span>Construir</span>
                <kbd>B</kbd>
              </button>
              <div className="bar-divider" />
              <button onClick={() => state.set({ focus: state.focus + 1 })}>
                <Crosshair size={22} />
                <span>Centralizar</span>
                <kbd>F</kbd>
              </button>
              <button onClick={() => state.set({ help: true })}>
                <HelpCircle size={22} />
                <span>Guia</span>
              </button>
            </nav>
            <div className="controls-hint">
              Clique para andar<span>Arraste com botão direito · Zoom com scroll</span>
            </div>
          </footer>
        </div>
      )}
      {state.help && <Help />}
    </main>
  );
}
