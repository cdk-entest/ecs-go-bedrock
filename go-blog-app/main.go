package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

var BedrockClient *bedrockruntime.Client

func init() {

	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRegion("us-east-1"))

	if err != nil {
		log.Fatal(err)
	}
	BedrockClient = bedrockruntime.NewFromConfig(cfg)

}

func main() {

	mux := http.NewServeMux()

	// home page
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./static/haiku.html")
	})

	// book page 
	mux.HandleFunc("/book", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./static/book.html")
	})

	// bedrock batch response
	mux.HandleFunc("/bedrock-haiku", HandleBedrockClaude3HaikuChat)

	// create web server
	server := &http.Server{
		Addr:           ":3001",
		Handler:        mux,
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   30 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	// enable logging
	log.Fatal(server.ListenAndServe())

}


