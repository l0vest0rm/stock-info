import { createApp } from "vue";
import { AppFooter } from "./components/app-footer";
import { AppTopNav } from "./components/app-top-nav";
import { CompanyInfoBar, FundInfoBar } from "./components/company-info-bar";
import { SubNav } from "./components/sub-nav";

function currentPage(): string {
  const parts = window.location.pathname.split("/");
  return parts[parts.length - 1] || "home.html";
}

function pageFromElement(element: HTMLElement): string {
  return element.dataset.page || currentPage();
}

export function mountLayout(): void {
  const topNav = document.getElementById("app-top-nav");
  if (topNav) {
    createApp(AppTopNav, { page: pageFromElement(topNav) }).mount(topNav);
  }

  document.querySelectorAll<HTMLElement>("[data-layout-subnav]").forEach((element) => {
    createApp(SubNav, { kind: element.dataset.layoutSubnav || "", page: pageFromElement(element) }).mount(element);
  });

  document.querySelectorAll<HTMLElement>("[data-layout-company-info]").forEach((element) => {
    createApp(CompanyInfoBar).mount(element);
  });

  document.querySelectorAll<HTMLElement>("[data-layout-fund-info]").forEach((element) => {
    createApp(FundInfoBar).mount(element);
  });

  const footer = document.getElementById("app-footer");
  if (footer) {
    createApp(AppFooter).mount(footer);
  }
}
