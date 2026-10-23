'use strict';
window.PET_DESKTOP = new URLSearchParams(window.location.search).get('desktop') === '1';
if (window.PET_DESKTOP) document.documentElement.classList.add('desktop-mode');
