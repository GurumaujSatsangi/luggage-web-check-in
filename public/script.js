    if (window.location.pathname.includes('/dashboard')) {
  document.addEventListener('DOMContentLoaded', function() {
    const urlParams = new URLSearchParams(window.location.search);
    const message = urlParams.get('message');
    const error = urlParams.get('error');
    
    if (message && typeof Swal !== 'undefined') {
      Swal.fire({
        icon: 'success',
        title: 'Success!',
        text: decodeURIComponent(message),
        confirmButtonColor: '#6366f1'
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    if (error && typeof Swal !== 'undefined') {
      Swal.fire({
        icon: 'error',
        title: 'Error!',
        text: decodeURIComponent(error),
        confirmButtonColor: '#ef4444'
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  });
}