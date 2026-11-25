# ATO Social Hub — App Review guide (English)

App ID 28751089997889323 · Unified Login config 1775718873720654 · https://socialhub.atodev.com.br/

> Fill in `<...>` after the real test (ENTREGA-FINAL.md, section E). Never put real credentials in this file; send them through the App Review "Test credentials" field.

## 1. Instructions for the reviewer

ATO Social Hub is a content-approval and publishing tool for professional Instagram accounts. A person reviews an image and a caption, then explicitly confirms the publication on their own Instagram professional account.

1. Open https://socialhub.atodev.com.br/ and sign in with the evaluation account: e-mail `<review e-mail>`, password `<provided in the test-credentials field>`.
2. The evaluation account belongs to an isolated demo company ("Meta Review Demo"). It has no access to any other company's data.
3. Go to **Conta** (Account) and click **Conectar Instagram** (Connect Instagram). Sign in with the Instagram professional test account `<@test_account>` (it has a role in the app). Approve the permissions shown by Meta.
4. Back in **Conta**, the page shows the connected `@username`, "Conta conectada e autorizada" and the permissions granted.
5. Go to **Posts**, open the demo post, click **Aprovar**, then **Agendar / Publicar**.
6. The dialog shows: the destination account, the image and the caption. Choose **Agora** (now), tick the confirmation box and click **Publicar agora**.
7. A confirmation appears only after the Instagram API returns a media ID, with a **Ver no Instagram** (View on Instagram) link when a permalink is returned. The same post appears in **Histórico** with status PUBLICADO and the account used.

## 2. Recording script (screen recording, with captions in English)

| # | Screen | Action | Caption to show |
|---|---|---|---|
| 1 | Login | Sign in with e-mail and password | "Internal sign-in to ATO Social Hub" |
| 2 | Dashboard | Show the "connect your Instagram" notice | "No Instagram account is connected yet" |
| 3 | Conta | Click Conectar Instagram | "The user chooses to connect an Instagram professional account" |
| 4 | Meta dialog | Show the permission list and approve | "Meta shows the requested permissions" |
| 5 | Conta | Show @username, status and permissions | "instagram_basic: identifies the connected account" |
| 6 | Posts | Open the demo post | "Content prepared for review" |
| 7 | Dialog | Show destination, image and caption; edit one word of the caption | "The user reviews the account, image and caption" |
| 8 | Dialog | Tick the confirmation, click Publicar agora | "instagram_content_publish: publish only after explicit confirmation" |
| 9 | Result | Show media ID and click Ver no Instagram | "Published through the Instagram API" |
| 10 | instagram.com | Show the real post on the test account | "The post exists on the connected account" |
| 11 | Histórico | Show the PUBLICADO entry | "History keeps the account and real status" |

Record the whole flow in one take, in real time (no cuts between steps 8 and 10), at 1080p, with the browser address bar visible.

## 3. Permission justifications

**instagram_basic.** Used to identify which Instagram professional account the user connected, so the app can show its `@username` and confirm the destination before any publication. Demonstrated in steps 4–5 and 7. Without it the app could not tell the user which account will be used.

**instagram_content_publish.** Used to publish the image and caption that the user reviewed and explicitly confirmed, to the connected Instagram professional account, and to read back the published media ID and permalink. The app never publishes without the confirmation step. Demonstrated in steps 7–10.

**instagram_manage_messages.** This permission is required by the Unified Login configuration (it cannot be removed in the Meta panel). ATO Social Hub does **not** read, send or manage messages or conversations, has no inbox or customer-service feature, and does not call any messaging endpoint. We are not requesting review or advanced access for messaging use; the permission appears only because the configuration requires it.

## 4. Evidence per permission

| Permission | Evidence |
|---|---|
| instagram_basic | Recording steps 4–5 (consent dialog, `@username`, status) and 7 (destination shown before publishing) |
| instagram_content_publish | Recording steps 7–10 (review, explicit confirmation, API-returned media ID, permalink, post visible on instagram.com), plus the history entry |
| instagram_manage_messages | Not used. Written statement above; no messaging screen exists in the app |

## 5. Resubmission checklist

- [ ] Production deployed and `/api/health` returns ok (ENTREGA-FINAL D)
- [ ] Evaluation account created; credentials entered in the test-credentials field
- [ ] Test Instagram account is professional and has a role in the app
- [ ] First real test completed and the post confirmed on instagram.com (ENTREGA-FINAL E)
- [ ] Recording follows section 2 in one continuous take
- [ ] Config shows only instagram_basic, instagram_content_publish and the required instagram_manage_messages
- [ ] Redirect URI `https://socialhub.atodev.com.br/api/auth/instagram/callback` matches
- [ ] Privacy Policy (`/privacidade`) and Terms (`/termos`) URLs reachable; data-deletion path works
- [ ] Justifications from section 3 pasted per permission
- [ ] Reviewer notes mention that messaging is required by the config but unused
