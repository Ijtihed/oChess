import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation, useParams } from "react-router-dom";
import AuthProvider, { useAuth } from "./components/AuthProvider";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import CustomCursor from "./components/CustomCursor";
import LandingPage from "./components/LandingPage";
import Dashboard from "./components/Dashboard";
import PlayPage from "./components/PlayPage";
import StudyPage from "./components/StudyPage";
import BotsPage from "./components/BotsPage";
import VariantsPage from "./components/VariantsPage";
import ReviewPage from "./components/ReviewPage";
import Profile from "./components/Profile";
import PublicProfile from "./components/PublicProfile";
import GameScreen, { getSavedGame, clearSavedGame } from "./components/GameScreen";
import { CreateChallenge, JoinChallenge } from "./components/ChallengePage";
import ComingSoon from "./components/ComingSoon";
import BoardStylePicker from "./components/BoardStylePicker";
import LoadingScreen from "./components/LoadingScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import LegalPage from "./components/LegalPage";

// Code-split the heaviest routes. Each pulls in chess.js + the
// engine UI / game flow / coach / Stockfish glue, so loading them on
// demand keeps the initial bundle under the threshold for slow
// connections. Suspense falls back to LoadingScreen while the chunk
// streams in.
const AnalysisPage = lazy(() => import("./components/AnalysisPage"));
const PuzzlesPage = lazy(() => import("./components/PuzzlesPage"));
const OnlineGameScreen = lazy(() => import("./components/OnlineGameScreen"));
const VariantGameScreen = lazy(() => import("./components/VariantGameScreen"));

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

const GUEST_KEY = "ochess_guest_session";

function AppShell() {
  const [authOpen, setAuthOpen] = useState(false);
  const [guest, setGuest] = useState(() => {
    try { return localStorage.getItem(GUEST_KEY) === "1"; } catch { return false; }
  });
  const { user: authUser, profile, loading: authLoading } = useAuth();
  // The signed-in user wins; if there's no auth session but the user
  // chose "Play as Guest", expose a synthetic local-only user so the
  // dashboard, profile shell, and online-disabled flows know to render
  // a guest experience instead of the landing page.
  const user = authUser ? {
    id: authUser.id,
    name: profile?.display_name || profile?.username || authUser.email?.split("@")[0] || "Player",
    email: authUser.email,
    avatar: profile?.avatar_url || authUser.user_metadata?.avatar_url || null,
    profile,
    guest: false,
  } : guest ? {
    id: "guest",
    name: "Guest",
    email: null,
    avatar: null,
    profile: null,
    guest: true,
  } : null;
  const navigate = useNavigate();
  const location = useLocation();

  const handleNavigate = useCallback(
    (id) => {
      const path = id === "home" ? "/" : `/${id}`;
      navigate(path);
      window.scrollTo({ top: 0 });
    },
    [navigate]
  );

  const handleLogin = useCallback(() => {
    // A real auth session has just been created (or is about to be).
    // Drop any guest flag and route home; the AuthProvider listener
    // is what actually populates `authUser`.
    try { localStorage.removeItem(GUEST_KEY); } catch {}
    setGuest(false);
    setAuthOpen(false);
    navigate("/");
  }, [navigate]);

  const handleGuest = useCallback(() => {
    try { localStorage.setItem(GUEST_KEY, "1"); } catch {}
    setGuest(true);
    setAuthOpen(false);
    navigate("/");
  }, [navigate]);

  const handleLogout = useCallback(async () => {
    try { const { signOut } = await import("./lib/auth"); await signOut(); } catch {}
    try { localStorage.removeItem(GUEST_KEY); } catch {}
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("sb-")) localStorage.removeItem(key);
    }
    window.location.href = "/";
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errDesc = params.get("error_description");
    if (errDesc) {
      setAuthOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const activePage = location.pathname === "/" ? "home" : location.pathname.slice(1);
  const isGameScreen =
    location.pathname === "/game" ||
    location.pathname === "/variant-game" ||
    location.pathname.startsWith("/game/online/") ||
    location.pathname === "/create-challenge" ||
    location.pathname.startsWith("/challenge/");
  const hideFooter = isGameScreen || location.pathname === "/analysis";
  const isLanding = location.pathname === "/" && !user;
  const [boardPrefsKey, setBoardPrefsKey] = useState(0);
  const showBoardPicker = !isLanding && !isGameScreen;

  if (authLoading) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-surface flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <span className="font-headline text-3xl font-extrabold tracking-tighter text-primary">oChess</span>
          <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen min-h-[100dvh] bg-surface text-on-surface overflow-x-hidden">
      {/* Skip link — only visible on keyboard focus, but lets screen
          reader / tab users jump past the persistent nav and social
          rail straight to the page body. */}
      <a href="#main"
         className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[10000] focus:px-3 focus:py-2 focus:bg-primary focus:text-on-primary focus:font-headline focus:text-xs focus:font-bold focus:uppercase focus:tracking-wide">
        Skip to main content
      </a>
      <CustomCursor />
      {!isGameScreen && (
        <Navbar
          activePage={activePage}
          onNavigate={handleNavigate}
          user={user}
          onAuthClick={() => setAuthOpen(true)}
        />
      )}
      <AuthModal
        open={authOpen && !isGameScreen}
        onClose={() => setAuthOpen(false)}
        onGuest={handleGuest}
        onLogin={handleLogin}
      />

      <main id="main" className={isGameScreen ? "" : "pt-16"}>
        <div className="page-enter">
          <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route
              path="/"
              element={
                user ? (
                  <Dashboard user={user} onNavigate={handleNavigate} />
                ) : (
                  <LandingPage onNavigate={handleNavigate} />
                )
              }
            />
            <Route path="/play" element={<PlayPage />} />
            <Route path="/puzzles" element={<PuzzlesPage />} />
            <Route path="/puzzles/:puzzleId" element={<PuzzlesPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/study" element={<StudyPage onNavigate={handleNavigate} />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/variants" element={<VariantsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/game" element={<GameRoute />} />
            <Route path="/variant-game" element={<VariantGameRoute />} />
            <Route path="/game/online/:gameId" element={<OnlineGameRoute />} />
            <Route path="/create-challenge" element={<CreateChallenge />} />
            <Route path="/challenge/:code" element={<JoinChallenge />} />
            <Route path="/u/:username" element={<PublicProfile />} />
            <Route
              path="/profile"
              element={<Profile />}
            />
            <Route path="/logout" element={<LogoutPage />} />
            <Route path="/legal/:slug" element={<LegalPage />} />
            <Route path="*" element={<ComingSoon page="unknown" onBack={() => handleNavigate("home")} />} />
          </Routes>
          </Suspense>
        </div>
      </main>

      {!hideFooter && <Footer />}
      {showBoardPicker && <BoardStylePicker onApply={() => setBoardPrefsKey((k) => k + 1)} />}
    </div>
  );
}

function OnlineGameRoute() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const [gameData, setGameData] = useState(location.state?.gameData || null);
  const [error, setError] = useState(null);

  // Refetch whenever gameId changes — including in-app navigation
  // from one online game to a rematch / new game without unmounting.
  // We accept a fast-path when location.state.gameData matches the
  // new id, but always re-load otherwise.
  useEffect(() => {
    if (!gameId) { setError("No game ID"); return; }
    if (gameData && gameData.id === gameId) return;
    setError(null);
    setGameData(null);
    let cancelled = false;
    import("./lib/supabase").then(({ supabase: sb }) => {
      if (cancelled) return;
      if (!sb) { setError("Not connected"); return; }
      sb.from("games").select("*").eq("id", gameId).maybeSingle()
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error || !data) setError("Game not found");
          else setGameData(data);
        })
        .catch(() => { if (!cancelled) setError("Failed to load game"); });
    });
    return () => { cancelled = true; };
  // gameData is intentionally excluded — we only refetch when gameId changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  if (error) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-surface flex items-center justify-center px-4">
        <div className="text-center">
          <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-on-surface-variant/55 mb-2">{error}</h1>
          <p className="text-[12px] text-on-surface-variant/55 mb-4">This game may have ended or doesn't exist.</p>
          <button onClick={() => navigate("/play")} className="btn btn-primary px-5 py-2 text-xs">Play</button>
        </div>
      </div>
    );
  }

  if (!gameData || authLoading) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-surface flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  const isParticipant = user?.id && (user.id === gameData.white_id || user.id === gameData.black_id);
  if (!isParticipant) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-surface flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-primary mb-2">Spectator mode</h1>
          <p className="text-[12px] text-on-surface-variant/55 mb-1">
            {gameData.white_name || "?"} vs {gameData.black_name || "?"} &middot; {gameData.time_control || "Unlimited"}
          </p>
          <p className="text-[11px] text-on-surface-variant/55 mb-6">
            Live spectating isn't available yet. {user ? "Open this link from one of the players' accounts to play." : "Sign in to play your own games."}
          </p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => navigate("/play")} className="btn btn-primary px-5 py-2 text-xs">
              Play
            </button>
            {gameData.status === "completed" && (
              <button onClick={() => navigate("/analysis", { state: { pgn: gameData.pgn } })} className="btn btn-secondary px-5 py-2 text-xs">
                View in analysis
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  const playerColor = user.id === gameData.white_id ? "w" : "b";
  return <OnlineGameScreen gameData={gameData} playerColor={playerColor} />;
}

function VariantGameRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state;
  if (!state?.variantId || !state?.opponent) {
    navigate("/variants", { replace: true });
    return null;
  }
  return (
    <VariantGameScreen
      variantId={state.variantId}
      opponent={state.opponent}
      playerColor={state.playerColor || "w"}
    />
  );
}

function GameRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state;

  if (state?.resume) {
    const saved = getSavedGame();
    if (saved) {
      return (
        <GameScreen
          opponent={saved.opponent}
          playerColor={saved.playerColor || "w"}
          timeControl={saved.timeControl || null}
          resumeData={saved}
          onBack={() => navigate("/play")}
        />
      );
    }
    navigate("/play", { replace: true });
    return null;
  }

  if (!state || !state.opponent) {
    navigate("/play", { replace: true });
    return null;
  }

  clearSavedGame();
  return (
    <GameScreen
      opponent={state.opponent}
      playerColor={state.playerColor || "w"}
      timeControl={state.timeControl}
      onBack={() => navigate("/play")}
    />
  );
}

function LogoutPage() {
  useEffect(() => {
    try { localStorage.removeItem(GUEST_KEY); } catch {}
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("sb-")) localStorage.removeItem(key);
    }
    const timeout = setTimeout(() => { window.location.href = "/"; }, 1500);
    import("./lib/supabase").then(({ supabase }) => {
      if (supabase) supabase.auth.signOut().finally(() => { clearTimeout(timeout); window.location.href = "/"; });
      else { clearTimeout(timeout); window.location.href = "/"; }
    }).catch(() => { clearTimeout(timeout); window.location.href = "/"; });
  }, []);
  return (
    <div className="min-h-screen min-h-[100dvh] bg-surface flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <span className="font-headline text-2xl font-extrabold tracking-tighter text-primary">Logging out...</span>
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    </div>
  );
}
