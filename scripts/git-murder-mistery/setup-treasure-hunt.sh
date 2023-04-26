mkdir git-murder-mystery
cd git-murder-mystery
git init

cp ../1905-04-26/news.md ./news.md
cp ../1905-04-26/image.jpg ./image.jpg
git add .
git commit --date="1905-04-26" -m "Wealthy Businessman Found Murdered in Colchester Mansion (1905)"

cp ../1911-11-12/news.md ./news.md
cp ../1911-11-12/image.jpg ./image.jpg
git add .
git commit --date="1911-11-12" -m "Shocking Murder of Young Woman Rocks Colchester Community (1911)"

cp ../1912-08-06/news.md ./news.md
cp ../1912-08-06/image.jpg ./image.jpg
git add .
git commit --date="1912-08-06" -m "Violent Crime Wave Continues in Colchester as Another Citizen Falls Victim (1912)"
