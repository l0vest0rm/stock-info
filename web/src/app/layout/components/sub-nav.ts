import { defineComponent, h } from "vue";
import { navConfig } from "../config/navigation";

type NavItem = {
  href: string;
  text: string;
};

function isLocalHost(): boolean {
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "0.0.0.0"
  );
}

function subnavItems(kind: string): NavItem[] {
  const filterLocalOnly = (items: NavItem[]) =>
    items.filter((item) => {
      if (item.href === "company-option.html") {
        return isLocalHost();
      }
      return true;
    });
  switch (kind) {
    case "companies":
      return navConfig.companiesNav;
    case "company":
      return filterLocalOnly(navConfig.companyNav);
    case "fund":
      return navConfig.fundNav;
    case "index":
      return navConfig.indexNav;
    default:
      return [];
  }
}

function subnavClass(page: string, href: string): string {
  const stateClass = page === href ? "btn-success active" : "btn-outline-success";
  return `btn btn-sm ${stateClass}`;
}

function renderSubnavLinks(kind: string, page: string) {
  return subnavItems(kind).map((item) =>
    h(
      "a",
      {
        key: item.href,
        href: item.href,
        name: "codeSpec",
        class: subnavClass(page, item.href),
        "aria-current": page === item.href ? "true" : undefined,
      },
      item.text
    )
  );
}

export const SubNav = defineComponent({
  name: "SubNav",
  props: {
    kind: {
      type: String,
      required: true,
    },
    page: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const nested = props.kind === "fund" || props.kind === "index";
      const buttonGroup = h(
        "div",
        { class: "d-flex flex-wrap justify-content-center gap-2 company-subnav-pills", role: "group" },
        renderSubnavLinks(props.kind, props.page)
      );
      if (nested) {
        return h("div", { id: "container", class: "py-2" }, [h("div", { class: "text-center" }, [buttonGroup])]);
      }
      return h("div", { class: "container text-center my-2" }, [buttonGroup]);
    };
  },
});
