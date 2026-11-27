import { expect, test } from "vitest";
import {
  checkTunnel,
  PROXY_URL_ERROR,
  PROXY_USERINFO_ERROR,
  placeTunnelFailure,
  proxyUrlProblem,
  targetText,
} from "./tunnelForm";

test("proxy URLs need http, https or socks5, a host, and nothing else", () => {
  for (const ok of [
    "http://p:3128",
    "https://p",
    "socks5://10.0.0.5:1080",
    "http://[::1]:8080/",
  ]) {
    expect(proxyUrlProblem(ok)).toBeNull();
  }
  for (const bad of [
    "ftp://p",
    "socks5h://p:1080",
    "http://p/x",
    "http://p?a=1",
    "http://p#f",
    "p:3128",
    "",
  ]) {
    expect(proxyUrlProblem(bad)).toBe(PROXY_URL_ERROR);
  }
  expect(proxyUrlProblem("http://me:pw@p:3128")).toBe(PROXY_USERINFO_ERROR);
  expect(proxyUrlProblem("socks5://me@p:1080")).toBe(PROXY_USERINFO_ERROR);
});

test("checkTunnel names each field's problem", () => {
  expect(
    checkTunnel({ name: " ", url: "http://p", username: "", password: "" }),
  ).toEqual({
    name: "A name is needed.",
  });
  expect(
    checkTunnel({
      name: "x".repeat(65),
      url: "ftp://p",
      username: "a:b",
      password: "",
    }),
  ).toEqual({
    name: "A name has at most 64 characters.",
    url: PROXY_URL_ERROR,
    username: 'A user name cannot hold ":" or control characters.',
  });
  expect(
    checkTunnel({
      name: "corp",
      url: " http://p:1 ",
      username: " me ",
      password: "pw",
    }),
  ).toEqual({});
});

test("a refusal shows under the field it names", () => {
  expect(placeTunnelFailure(new Error(PROXY_USERINFO_ERROR))).toEqual({
    url: PROXY_USERINFO_ERROR,
  });
  expect(
    placeTunnelFailure(new Error('A tunnel named "corp" exists already.')),
  ).toEqual({
    name: 'A tunnel named "corp" exists already.',
  });
  expect(placeTunnelFailure(new Error("A user name cannot hold"))).toEqual({
    username: "A user name cannot hold",
  });
  expect(
    placeTunnelFailure(new Error("This tunnel no longer exists.")),
  ).toEqual({
    form: "This tunnel no longer exists.",
  });
});

test("targetText names the proxy URL or the SSH target", () => {
  expect(
    targetText({ type: "proxy", url: "http://proxy:3128", username: null }),
  ).toBe("Proxy · http://proxy:3128");
  expect(
    targetText({
      type: "ssh",
      host: "bastion",
      user: "me",
      port: 2222,
      jump: "jump.corp",
      identityFile: null,
    }),
  ).toBe("SSH · me@bastion:2222 via jump.corp");
  expect(
    targetText({
      type: "ssh",
      host: "coder.ws",
      user: null,
      port: null,
      jump: null,
      identityFile: null,
    }),
  ).toBe("SSH · coder.ws");
});
