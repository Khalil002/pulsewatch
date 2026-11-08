FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/Pulsewatch.Api/Pulsewatch.Api.csproj src/Pulsewatch.Api/
RUN dotnet restore src/Pulsewatch.Api/Pulsewatch.Api.csproj
COPY src/ src/
RUN dotnet publish src/Pulsewatch.Api -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
USER app
EXPOSE 8000
ENTRYPOINT ["dotnet", "Pulsewatch.Api.dll"]
