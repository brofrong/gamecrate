// Фикстуры Steam OpenID для тестов: подделка `fetch` (проверка подписи и Steam Web API)
// и построение ответа Steam (`id_res`), с которым браузер возвращается на `return_to`.
// Общие для `steamLogin.test.ts` и `linking.test.ts`.

export const steamId = "76561197960287930";
export const steamOpenIdUrl = "https://steamcommunity.com/openid/login";

/** `fetch` до подмены — для восстановления в `afterAll` и фолбэка внутри фикстуры. */
export const realFetch = globalThis.fetch;

/** Steam: проверка подписи OpenID всегда успешна, профиль — фиксированный. */
export const fakeSteamFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === steamOpenIdUrl)
    return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
  if (url.startsWith("https://api.steampowered.com/ISteamUser/"))
    return Response.json({
      response: {
        players: [
          {
            steamid: steamId,
            personaname: "Gabe",
            avatarfull: "https://avatars.example/full.jpg",
            profileurl: `https://steamcommunity.com/profiles/${steamId}/`,
          },
        ],
      },
    });
  return realFetch(input, init);
};

/** Ответ Steam (`id_res`), с которым браузер возвращается на `return_to`. */
export const steamResponseParams = (returnTo: string) => {
  const claimedId = `https://steamcommunity.com/openid/id/${steamId}`;
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": steamOpenIdUrl,
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": `${new Date().toISOString().slice(0, 19)}Z${crypto.randomUUID()}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "W0u5DRbtHE1GG0ZKXvh8GreQhow=",
  });
};
