// Trilhos Portal — Fase P1: esqueleto + login
//
// Usa a biblioteca Google Identity Services (GIS) para autenticacao.
// Nesta fase confirmamos apenas que o login funciona e mostramos a
// identidade da conta (nome, email, foto). A leitura da Google Drive
// (com o scope drive.file) entra na Fase P2.

// Client ID Web do projeto trilhos-498408 (o mesmo cliente da app e da PWA).
// E um identificador publico — nao e um segredo, pode viver no codigo do browser.
const CLIENT_ID = '271389330523-4jg4e39cgf31v7mecjabj4hji6pjug1k.apps.googleusercontent.com';

const viewLogin = document.getElementById('view-login');
const viewAuthed = document.getElementById('view-authed');
const userAvatar = document.getElementById('user-avatar');
const userEmail = document.getElementById('user-email');
const btnSignout = document.getElementById('btn-signout');

const SESSION_KEY = 'trilhos_portal_session';

function decodeJwt(token) {
  // O ID token e um JWT: header.payload.assinatura, em base64url.
  const payload = token.split('.')[1];
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent(escape(json)));
}

function showAuthed(profile) {
  userAvatar.src = profile.picture || '';
  userEmail.textContent = profile.email || '';
  viewLogin.hidden = true;
  viewAuthed.hidden = false;
}

function showLogin() {
  viewLogin.hidden = false;
  viewAuthed.hidden = true;
}

function handleCredentialResponse(response) {
  try {
    const profile = decodeJwt(response.credential);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(profile));
    showAuthed(profile);
  } catch (err) {
    console.error('Falha ao processar a sessão Google:', err);
  }
}

function init() {
  // Restaurar sessao desta aba, se existir (sessionStorage: dura so a sessao do browser)
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      showAuthed(JSON.parse(saved));
    } catch (_) {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  if (!window.google || !google.accounts || !google.accounts.id) {
    // Biblioteca do Google ainda nao carregou (rede lenta); tenta de novo em breve.
    setTimeout(init, 300);
    return;
  }

  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
  });

  google.accounts.id.renderButton(
    document.getElementById('g_id_signin'),
    { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' }
  );
}

btnSignout.addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  showLogin();
});

init();
