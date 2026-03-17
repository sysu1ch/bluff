const joinForm = document.querySelector('#join-form');
const nicknameInput = document.querySelector('#nickname');
const errorMessage = document.querySelector('#error-message');
const joinCard = document.querySelector('#join-card');
const roomCard = document.querySelector('#room-card');
const welcomeMessage = document.querySelector('#welcome-message');

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const nickname = nicknameInput.value.trim();

  if (!nickname) {
    errorMessage.textContent = '请输入昵称后再进入房间。';
    nicknameInput.focus();
    return;
  }

  errorMessage.textContent = '';
  joinCard.classList.add('hidden');
  roomCard.classList.remove('hidden');
  welcomeMessage.textContent = `你好，${nickname}！你已成功进入房间。`;
});
