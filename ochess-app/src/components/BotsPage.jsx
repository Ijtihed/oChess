import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function BotsPage() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/play", { state: { tab: "bots" }, replace: true });
  }, [navigate]);
  return null;
}
