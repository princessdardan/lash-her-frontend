// Browser route tests do not need external font downloads.
const css = (family) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 100 900;
  src: local('Arial');
}`;

module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap":
    css("Inter"),
  "https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap":
    css("Bebas Neue"),
};
