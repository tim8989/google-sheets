// script.js: 处理页面交互功能

// 动态加载navbar.html
function loadNavbar() {
    fetch('navbar.html')
      .then(response => response.text())
      .then(data => {
        document.getElementById('navbar-container').innerHTML = data;
      })
      .catch(error => console.error('Error loading navbar:', error));
  }
  
  // 初始化时加载navbar
  loadNavbar();