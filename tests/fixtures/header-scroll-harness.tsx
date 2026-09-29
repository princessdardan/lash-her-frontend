import { useEffect } from "react";
import {
  HeaderWrapper,
  useHeaderContext,
} from "@/components/custom/layouts/header-wrapper";
import { MainWrapper } from "@/components/custom/layouts/main-wrapper";

function HeaderContent() {
  const { isActive } = useHeaderContext();
  return (
    <span style={{ color: isActive ? "#1c1318" : "#fff" }}>Navigation</span>
  );
}

export function Harness() {
  useEffect(() => {
    document.body.dataset.hydrated = "true";
  }, []);
  return (
    <>
      <HeaderWrapper>
        <HeaderContent />
      </HeaderWrapper>
      <MainWrapper>
        <section style={{ height: 1200, background: "#1c1318" }}>Hero</section>
        <section style={{ height: 1200 }}>Content</section>
      </MainWrapper>
    </>
  );
}
