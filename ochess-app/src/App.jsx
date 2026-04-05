import { useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import CustomCursor from "./components/CustomCursor";
import LandingPage from "./components/LandingPage";
import Dashboard from "./components/Dashboard";
import PlayPage from "./components/PlayPage";
import PuzzlesPage from "./components/PuzzlesPage";
import AnalysisPage from "./components/AnalysisPage";
import StudyPage from "./components/StudyPage";
import BotsPage from "./components/BotsPage";
import VariantsPage from "./components/VariantsPage";
import ReviewPage from "./components/ReviewPage";
import Profile from "./components/Profile";
import GameScreen, { getSavedGame, clearSavedGame } from "./components/GameScreen";
import ComingSoon from "./components/ComingSoon";
import BoardStylePicker from "./components/BoardStylePicker";

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const [authOpen, setAuthOpen] = useState(false);
  const [user, setUser] = useState(null);
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

  const handleLogin = useCallback(
    (u) => {
      setUser(u);
      setAuthOpen(false);
      navigate("/");
    },
    [navigate]
  );

  const handleGuest = useCallback(() => {
    handleLogin({ name: "Guest", guest: true });
  }, [handleLogin]);

  const handleLogout = useCallback(() => {
    setUser(null);
    navigate("/");
  }, [navigate]);

  const activePage = location.pathname === "/" ? "home" : location.pathname.slice(1);
  const isGameScreen = location.pathname === "/game";
  const hideFooter = isGameScreen || location.pathname === "/analysis";
  const isLanding = location.pathname === "/" && !user;
  const [boardPrefsKey, setBoardPrefsKey] = useState(0);
  const showBoardPicker = !isLanding;

  return (
    <div className="min-h-screen min-h-[100dvh] bg-surface text-on-surface overflow-x-hidden">
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
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onGuest={handleGuest}
        onLogin={handleLogin}
      />

      <main className={isGameScreen ? "" : "pt-16"}>
        <div className="page-enter">
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
            <Route path="/variants" element={<VariantsPage onNavigate={handleNavigate} />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/game" element={<GameRoute />} />
            <Route
              path="/profile"
              element={<Profile user={user || { name: "Guest", guest: true }} onNavigate={handleNavigate} onLogout={handleLogout} />}
            />
            <Route path="*" element={<ComingSoon page="unknown" onBack={() => handleNavigate("home")} />} />
          </Routes>
        </div>
      </main>

      {!hideFooter && <Footer />}
      {showBoardPicker && <BoardStylePicker onApply={() => setBoardPrefsKey((k) => k + 1)} />}
    </div>
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
